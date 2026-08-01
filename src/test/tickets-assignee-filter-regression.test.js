const fs = require('fs');
const path = require('path');
const assert = require('assert');

function testTicketsAssigneeFilterRegression() {
    const htmlPath = path.join(__dirname, '../webview/planning.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const jsPath = path.join(__dirname, '../webview/planning.js');
    const js = fs.readFileSync(jsPath, 'utf8');

    // Assertion 1: markup element exists
    assert.ok(
        html.includes('id="tickets-assignee-filter"'),
        'Expected tickets-assignee-filter select in planning.html'
    );

    // Assertion 2: element accessor in getTicketsTabElements
    assert.ok(
        js.includes('assigneeFilter: document.getElementById(\'tickets-assignee-filter\')'),
        'Expected assigneeFilter in getTicketsTabElements()'
    );

    // Assertion 3: predicates positioned in funnels
    assert.ok(
        js.includes('const assigneeFilter = String(linearProjectAssigneeFilterValue || \'\').trim();'),
        'Expected assigneeFilter in getFilteredLinearIssues'
    );
    assert.ok(
        js.includes('const assigneeFilter = String(clickUpProjectAssigneeFilterValue || \'\').trim();'),
        'Expected assigneeFilter in getFilteredClickUpTasks'
    );

    // Assertion 4: reset parity for status filter reset sites
    const statusResetCount = (js.match(/clickUpProjectStatusFilterValue\s*=\s*''/g) || []).length;
    const assigneeResetCount = (js.match(/clickUpProjectAssigneeFilterValue\s*=\s*''/g) || []).length;
    assert.ok(
        assigneeResetCount >= statusResetCount,
        `Expected clickUpProjectAssigneeFilterValue resets (${assigneeResetCount}) to match or exceed status resets (${statusResetCount})`
    );

    console.log('tickets-assignee-filter-regression.test.js passed');
}

testTicketsAssigneeFilterRegression();
