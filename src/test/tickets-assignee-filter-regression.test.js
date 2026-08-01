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

    // Assertion 5: same reset parity on the Linear side. A missed site leaves a stale
    // assignee id applied after a project switch — the silently-empty-sidebar failure.
    const linearStateResetCount = (js.match(/linearProjectStateFilterValue\s*=\s*''/g) || []).length;
    const linearAssigneeResetCount = (js.match(/linearProjectAssigneeFilterValue\s*=\s*''/g) || []).length;
    assert.ok(
        linearAssigneeResetCount >= linearStateResetCount,
        `Expected linearProjectAssigneeFilterValue resets (${linearAssigneeResetCount}) to match or exceed linear state resets (${linearStateResetCount})`
    );

    // Assertion 6: assignee identity must tolerate id-less assignees. The file-backed
    // sidebar path (localTicketFilesListed) carries assignee NAMES only, so keying
    // strictly on `.id` leaves the dropdown permanently empty in the steady state.
    assert.ok(
        js.includes('function _ticketsAssigneeKey('),
        'Expected _ticketsAssigneeKey() name-fallback helper'
    );
    assert.ok(
        js.includes('_clickUpAssigneeIdentity(') && js.includes('_linearAssigneeIdentity('),
        'Expected per-provider assignee identity helpers'
    );
    assert.ok(
        !/some\(a\s*=>\s*String\(a\?\.id\)\s*===\s*assigneeFilter\)/.test(js),
        'ClickUp assignee predicate must not match on raw id only — id-less file-backed assignees would never match'
    );
    assert.ok(
        !/String\(issue\?\.assignee\?\.id\s*\|\|\s*''\)\s*!==\s*assigneeFilter/.test(js),
        'Linear assignee predicate must not match on raw id only'
    );

    // Assertion 7: Linear and ClickUp share ONE assignee <select>, so they must share
    // ONE html cache var. Per-provider caches report "unchanged" while the DOM still
    // holds the other provider's options (stale dropdown + silently wiped filter).
    assert.ok(
        !js.includes('_lastTicketsLinearAssigneeFilterHtml') && !js.includes('_lastTicketsClickUpAssigneeFilterHtml'),
        'Expected a single shared _lastTicketsAssigneeFilterHtml cache, not per-provider caches'
    );
    const sharedCacheDecls = (js.match(/let _lastTicketsAssigneeFilterHtml\s*=/g) || []).length;
    assert.strictEqual(sharedCacheDecls, 1, 'Expected exactly one _lastTicketsAssigneeFilterHtml declaration');

    console.log('tickets-assignee-filter-regression.test.js passed');
}

testTicketsAssigneeFilterRegression();
