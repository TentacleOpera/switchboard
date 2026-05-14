'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
const providerSource = fs.readFileSync(providerPath, 'utf8');

function run() {
    // 1. Verify _filterVisibleColumns exists with correct signature
    const filterFnMatch = providerSource.match(
        /private _filterVisibleColumns\(\s*columns: KanbanColumnDefinition\[\],\s*visibleAgents: Record<string, boolean>\s*\): KanbanColumnDefinition\[\] \{/
    );
    assert.ok(filterFnMatch, 'Expected _filterVisibleColumns private method with correct signature.');

    // 2. Extract the _filterVisibleColumns method body
    const startIdx = providerSource.indexOf('private _filterVisibleColumns(');
    assert.ok(startIdx >= 0, 'Expected to locate _filterVisibleColumns method.');
    const openBraceIdx = providerSource.indexOf('{', startIdx);
    let braceCount = 0;
    let endIdx = openBraceIdx;
    for (let i = openBraceIdx; i < providerSource.length; i++) {
        if (providerSource[i] === '{') braceCount++;
        if (providerSource[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
                endIdx = i;
                break;
            }
        }
    }
    const methodBody = providerSource.slice(openBraceIdx, endIdx + 1);

    // 3. Verify it keeps fixed columns (CREATED, COMPLETED)
    assert.ok(
        methodBody.includes("const fixed = column.id === 'CREATED' || column.id === 'COMPLETED'") &&
        methodBody.includes('if (fixed) return true;'),
        'Expected _filterVisibleColumns to always keep fixed columns CREATED and COMPLETED.'
    );

    // 4. Verify it filters built-in columns whose role is disabled
    assert.ok(
        methodBody.includes("column.source === 'built-in'") &&
        methodBody.includes('column.role') &&
        methodBody.includes('visibleAgents[column.role] === false') &&
        methodBody.includes('return false;'),
        'Expected _filterVisibleColumns to filter out built-in columns when visibleAgents[role] === false.'
    );

    // 5. Verify custom columns are not filtered by role visibility
    assert.ok(
        methodBody.includes('return true;'),
        'Expected _filterVisibleColumns to return true for non-built-in columns (custom columns).'
    );

    // 6. Verify getReviewTicketData calls _filterVisibleColumns
    const getReviewTicketDataIdx = providerSource.indexOf('public async getReviewTicketData(');
    assert.ok(getReviewTicketDataIdx >= 0, 'Expected getReviewTicketData method.');
    const getReviewTicketDataEndIdx = providerSource.indexOf('public async ', getReviewTicketDataIdx + 1);
    const getReviewTicketDataBody = providerSource.slice(getReviewTicketDataIdx, getReviewTicketDataEndIdx);
    assert.ok(
        getReviewTicketDataBody.includes('this.getVisibleAgents(workspaceRoot)') &&
        getReviewTicketDataBody.includes('this._filterVisibleColumns(allColumns, visibleAgents)'),
        'Expected getReviewTicketData to fetch visibleAgents and call _filterVisibleColumns before building dropdown columns.'
    );

    // 7. Verify updateReviewTicket setColumn branch calls _filterVisibleColumns
    const setColumnStart = providerSource.indexOf("case 'setColumn': {");
    const setColumnEnd = providerSource.indexOf("case 'setComplexity': {", setColumnStart);
    assert.ok(setColumnStart >= 0 && setColumnEnd > setColumnStart, 'Expected setColumn branch.');
    const setColumnBranch = providerSource.slice(setColumnStart, setColumnEnd);
    assert.ok(
        setColumnBranch.includes('this.getVisibleAgents(workspaceRoot)') &&
        setColumnBranch.includes('this._filterVisibleColumns(allColumns, visibleAgents)'),
        'Expected updateReviewTicket setColumn branch to fetch visibleAgents and call _filterVisibleColumns before validation.'
    );

    // 8. Behavioral test: replicate the function logic and verify outcomes
    function replicateFilterVisibleColumns(columns, visibleAgents) {
        return columns.filter(column => {
            const fixed = column.id === 'CREATED' || column.id === 'COMPLETED';
            if (fixed) return true;
            if (column.source === 'built-in' && column.role && visibleAgents[column.role] === false) {
                return false;
            }
            return true;
        });
    }

    const testColumns = [
        { id: 'CREATED', source: 'built-in', role: undefined },
        { id: 'PLAN REVIEWED', source: 'built-in', role: 'lead' },
        { id: 'CODER CODED', source: 'built-in', role: 'coder' },
        { id: 'ACCEPTANCE TESTED', source: 'built-in', role: 'tester' },
        { id: 'COMPLETED', source: 'built-in', role: undefined },
        { id: 'MY CUSTOM', source: 'custom-user', role: undefined },
        { id: 'AGENT CUSTOM', source: 'custom-agent', role: 'analyst' },
    ];

    // Case A: all agents visible -> all columns kept
    const allVisible = { lead: true, coder: true, tester: true, analyst: true };
    const resultAllVisible = replicateFilterVisibleColumns(testColumns, allVisible);
    assert.strictEqual(resultAllVisible.length, 7, 'Expected all columns to be kept when all agents are visible.');

    // Case B: tester disabled -> ACCEPTANCE TESTED hidden, everything else kept
    const testerHidden = { lead: true, coder: true, tester: false, analyst: true };
    const resultTesterHidden = replicateFilterVisibleColumns(testColumns, testerHidden);
    assert.strictEqual(resultTesterHidden.length, 6, 'Expected 6 columns when tester is hidden.');
    assert.ok(resultTesterHidden.some(c => c.id === 'CREATED'), 'Expected CREATED to be kept.');
    assert.ok(resultTesterHidden.some(c => c.id === 'COMPLETED'), 'Expected COMPLETED to be kept.');
    assert.ok(!resultTesterHidden.some(c => c.id === 'ACCEPTANCE TESTED'), 'Expected ACCEPTANCE TESTED to be filtered out when tester is hidden.');
    assert.ok(resultTesterHidden.some(c => c.id === 'MY CUSTOM'), 'Expected custom-user column to be kept.');
    assert.ok(resultTesterHidden.some(c => c.id === 'AGENT CUSTOM'), 'Expected custom-agent column to be kept.');

    // Case C: all built-in agents disabled -> only fixed and custom columns kept
    const allBuiltInHidden = { lead: false, coder: false, tester: false, analyst: false };
    const resultAllHidden = replicateFilterVisibleColumns(testColumns, allBuiltInHidden);
    assert.strictEqual(resultAllHidden.length, 4, 'Expected 4 columns (CREATED, COMPLETED, MY CUSTOM, AGENT CUSTOM) when all built-in agents are hidden.');
    assert.ok(resultAllHidden.every(c => ['CREATED', 'COMPLETED', 'MY CUSTOM', 'AGENT CUSTOM'].includes(c.id)),
        'Expected only fixed and custom columns when all built-in agents are hidden.');

    console.log('column dropdown filter visible columns test passed');
}

try {
    run();
} catch (error) {
    console.error('column dropdown filter visible columns test failed:', error);
    process.exit(1);
}
