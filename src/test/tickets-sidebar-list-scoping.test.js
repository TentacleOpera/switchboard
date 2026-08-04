const fs = require('fs');
const path = require('path');
const assert = require('assert');

function testTicketsSidebarListScoping() {
    // ── 2f: repointed from planning.js/PlanningPanelProvider.ts to
    //    tickets.js/TicketsPanelProvider.ts (tickets tab moved to its own panel). ──
    const ticketsJsPath = path.join(__dirname, '../webview/tickets.js');
    const ticketsJs = fs.readFileSync(ticketsJsPath, 'utf8');

    const providerPath = path.join(__dirname, '../services/TicketsPanelProvider.ts');
    const providerTs = fs.readFileSync(providerPath, 'utf8');

    // Assertion 1-3: Dispatch order in planning.js fetchRootsComplete is now
    // moot — the Tickets panel has separate `rootsFetched`, `restoredTabState`,
    // and `integrationProviderStates` message cases (pushed by the host in
    // order, not re-dispatched internally by the webview). The architectural
    // shift means there is no single `fetchRootsComplete` body to assert on.
    // Instead, assert the three cases exist independently in tickets.js.
    assert.strictEqual(ticketsJs.indexOf("case 'rootsFetched':") !== -1, true, "case 'rootsFetched': must exist in tickets.js");
    assert.strictEqual(ticketsJs.indexOf("case 'restoredTabState':") !== -1, true, "case 'restoredTabState': must exist in tickets.js");
    assert.strictEqual(ticketsJs.indexOf("case 'integrationProviderStates':") !== -1, true, "case 'integrationProviderStates': must exist in tickets.js");

    // Assertion 4: loadLocalTicketFiles contains ClickUp no-list synthetic dispatch early return
    const loadLocalIdx = ticketsJs.indexOf('function loadLocalTicketFiles()');
    assert.strictEqual(loadLocalIdx !== -1, true, 'loadLocalTicketFiles function must exist in tickets.js');
    const loadLocalEnd = ticketsJs.indexOf('function _requestTicketSyncStatuses()', loadLocalIdx);
    const loadLocalBody = ticketsJs.slice(loadLocalIdx, loadLocalEnd);

    assert.match(
        loadLocalBody,
        /if\s*\(\s*lastIntegrationProvider\s*===\s*'clickup'\s*&&\s*!effectiveListId\s*\)\s*\{[\s\S]*?unscopedPlaceholder:\s*true[\s\S]*?return;\s*\}/,
        "loadLocalTicketFiles must synthetically dispatch empty localTicketFilesListed with unscopedPlaceholder when ClickUp has no selected list"
    );

    // Assertion 5: Latch site in case 'localTicketFilesListed' is guarded by !msg.unscopedPlaceholder
    const localListedIdx = ticketsJs.indexOf("case 'localTicketFilesListed':");
    assert.strictEqual(localListedIdx !== -1, true, "case 'localTicketFilesListed': must exist in tickets.js");
    const localListedBody = ticketsJs.slice(localListedIdx, localListedIdx + 300);
    assert.match(
        localListedBody,
        /if\s*\(\s*!message\.unscopedPlaceholder\s*\)\s*\{\s*ticketsLoadedOnce\s*=\s*true;\s*\}/,
        "ticketsLoadedOnce latch must be guarded by !message.unscopedPlaceholder"
    );

    // Assertion 6: restoreTicketsStateForRoot contains _ticketsListedUnscoped re-issue check without modifying ticketsLoadedOnce
    const restoreTicketsIdx = ticketsJs.indexOf('function restoreTicketsStateForRoot(state)');
    assert.strictEqual(restoreTicketsIdx !== -1, true, 'restoreTicketsStateForRoot function must exist in tickets.js');
    const restoreTicketsEnd = ticketsJs.indexOf('function restoreTicketsState()', restoreTicketsIdx);
    const restoreTicketsBody = ticketsJs.slice(restoreTicketsIdx, restoreTicketsEnd);

    assert.match(
        restoreTicketsBody,
        /if\s*\(\s*_ticketsListedUnscoped\s*&&\s*currentScopeId\s*\)\s*\{\s*_ticketsListedUnscoped\s*=\s*false;\s*loadLocalTicketFiles\(\);\s*\}/,
        "restoreTicketsStateForRoot must re-issue loadLocalTicketFiles when previous list was unscoped and scope is now known"
    );
    assert.strictEqual(
        /ticketsLoadedOnce\s*=/.test(restoreTicketsBody),
        false,
        "restoreTicketsStateForRoot must not assign ticketsLoadedOnce — the late re-issue must not re-open the double-fetch the latch prevents"
    );

    // Assertion 7: TicketsPanelProvider fallback scan passes scopeId & skipSubtasks, backfill scan does not
    const providerListLocalIdx = providerTs.indexOf("case 'listLocalTicketFiles':");
    assert.strictEqual(providerListLocalIdx !== -1, true, "case 'listLocalTicketFiles': must exist in TicketsPanelProvider");
    const providerListLocalEnd = providerTs.indexOf("case 'getTicketSyncStatuses':", providerListLocalIdx);
    const providerListLocalBody = providerTs.slice(providerListLocalIdx, providerListLocalEnd);

    assert.match(
        providerListLocalBody,
        /_scanLocalTicketFiles\s*\(\s*dir,\s*provider,\s*tickets,\s*\{\s*scopeId,\s*skipSubtasks:\s*true\s*\}\s*\)/,
        "Fallback scan call in listLocalTicketFiles must pass { scopeId, skipSubtasks: true }"
    );

    const backfillCall = providerListLocalBody.match(
        /this\._scanLocalTicketFiles\s*\(\s*dir,\s*provider,\s*scannedTickets\s*([^)]*)\)/
    );
    assert.ok(
        backfillCall,
        'Backfill scan call this._scanLocalTicketFiles(dir, provider, scannedTickets) must exist in listLocalTicketFiles'
    );
    assert.strictEqual(
        backfillCall[1].trim(),
        '',
        'Backfill scan call must NOT pass a scopeId/skipSubtasks option — orphan subtask files must keep being registered'
    );

    // Assertion 8: Scoping coverage warn AND its counters exist together
    assert.match(
        providerListLocalBody,
        /console\.warn\(`\[TicketsPanelProvider\] listLocalTicketFiles scoping hid all candidate files for \${provider}/,
        "TicketsPanelProvider listLocalTicketFiles must log a warning when scoping hides all candidate files"
    );
    for (const counter of ['totalCandidates', 'hiddenByScope', 'hiddenBySubtask']) {
        assert.ok(
            providerListLocalBody.includes(`${counter}++`),
            `listLocalTicketFiles must increment ${counter} so the coverage warn reports real counts`
        );
    }

    // Assertion 9: the coverage counts travel back on the response
    assert.match(
        providerListLocalBody,
        /scopeCoverage\s*=\s*\{\s*total:\s*totalCandidates/,
        'listLocalTicketFiles must record scopeCoverage when scoping hides every candidate file'
    );
    assert.match(
        providerListLocalBody,
        /const res = \{ type: 'localTicketFilesListed', provider, tickets, \.\.\.\(scopeCoverage \?/,
        'localTicketFilesListed response must carry scopeCoverage'
    );
    assert.match(
        ticketsJs,
        /_ticketsScopeCoverage\s*=\s*message\.scopeCoverage\s*\|\|\s*null;/,
        'localTicketFilesListed handler must capture message.scopeCoverage'
    );
    assert.match(
        ticketsJs,
        /don't carry a list id — Refetch this list to re-key them/,
        'the empty state must offer the re-key copy rather than a bare "No tasks found."'
    );
    assert.match(
        ticketsJs,
        /don't carry a project name — Refetch this project to re-key them/,
        'the re-key copy must name projectName for Linear, not "list id"'
    );

    // Assertion 10: the no-list-selected state says so
    assert.match(
        ticketsJs,
        /_ticketsAwaitingListSelection\s*=\s*!!message\.unscopedPlaceholder;/,
        "the localTicketFilesListed handler must record the unscopedPlaceholder marker"
    );
    assert.match(
        ticketsJs,
        /if\s*\(\s*_ticketsAwaitingListSelection\s*\)\s*\{\s*return\s+'Select a space and list to see its tickets\.';/,
        'the ClickUp no-list-selected placeholder must render the "Select a space and list" empty state'
    );

    // Assertion 11: BOTH provider renderers route through the shared copy helper
    const clickUpRenderIdx = ticketsJs.indexOf('function renderTicketsClickUpList()');
    const linearRenderIdx = ticketsJs.indexOf('function renderTicketsLinearList()');
    assert.strictEqual(clickUpRenderIdx !== -1 && linearRenderIdx !== -1, true, 'both ticket list renderers must exist in tickets.js');
    for (const [name, startIdx, endNeedle] of [
        ['renderTicketsClickUpList', clickUpRenderIdx, 'function renderTicketsClickUpTaskDetail()'],
        ['renderTicketsLinearList', linearRenderIdx, 'function renderTicketsLinearTaskDetail()']
    ]) {
        const endIdx = ticketsJs.indexOf(endNeedle, startIdx);
        assert.strictEqual(endIdx !== -1, true, `expected to find ${endNeedle}`);
        assert.ok(
            ticketsJs.slice(startIdx, endIdx).includes('_ticketsEmptyStateCopy('),
            `${name} must render its empty state through _ticketsEmptyStateCopy`
        );
    }
}

if (require.main === module) {
    testTicketsSidebarListScoping();
    console.log('testTicketsSidebarListScoping passed.');
}

module.exports = { testTicketsSidebarListScoping };
