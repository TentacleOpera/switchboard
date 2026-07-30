const fs = require('fs');
const path = require('path');
const assert = require('assert');

function testTicketsSidebarListScoping() {
    const planningJsPath = path.join(__dirname, '../webview/planning.js');
    const planningJs = fs.readFileSync(planningJsPath, 'utf8');

    const providerPath = path.join(__dirname, '../services/PlanningPanelProvider.ts');
    const providerTs = fs.readFileSync(providerPath, 'utf8');

    // Assertion 1: Dispatch order in case 'fetchRootsComplete'
    // restoredTabState dispatch index < integrationProviderStates dispatch index && > workspaceItemsUpdated dispatch index
    const fetchRootsIdx = planningJs.indexOf("case 'fetchRootsComplete':");
    assert.strictEqual(fetchRootsIdx !== -1, true, "case 'fetchRootsComplete': must exist in planning.js");
    const fetchRootsEnd = planningJs.indexOf('break;', fetchRootsIdx);
    const fetchRootsBody = planningJs.slice(fetchRootsIdx, fetchRootsEnd);

    const wsItemsIdx = fetchRootsBody.indexOf("type: 'workspaceItemsUpdated'");
    const restoredTabIdx = fetchRootsBody.indexOf("type: 'restoredTabState'");
    const providerStatesIdx = fetchRootsBody.indexOf("type: 'integrationProviderStates'");

    assert.strictEqual(wsItemsIdx !== -1, true, "workspaceItemsUpdated dispatch must exist in fetchRootsComplete");
    assert.strictEqual(restoredTabIdx !== -1, true, "restoredTabState dispatch must exist in fetchRootsComplete");
    assert.strictEqual(providerStatesIdx !== -1, true, "integrationProviderStates dispatch must exist in fetchRootsComplete");

    assert.strictEqual(
        wsItemsIdx < restoredTabIdx,
        true,
        "restoredTabState dispatch must come AFTER workspaceItemsUpdated dispatch"
    );
    assert.strictEqual(
        restoredTabIdx < providerStatesIdx,
        true,
        "restoredTabState dispatch must come BEFORE integrationProviderStates dispatch"
    );

    // Assertion 2: restoredTabState dispatch is guarded by !_restoredTabStateReceived, and case 'restoredTabState' sets it
    assert.match(
        fetchRootsBody,
        /if\s*\(\s*msg\.restoredTabState\s*&&\s*!_restoredTabStateReceived\s*\)/,
        "restoredTabState dispatch in fetchRootsComplete must be guarded by !_restoredTabStateReceived"
    );
    const restoredCaseIdx = planningJs.indexOf("case 'restoredTabState':");
    assert.strictEqual(restoredCaseIdx !== -1, true, "case 'restoredTabState': must exist");
    const restoredCaseBody = planningJs.slice(restoredCaseIdx, restoredCaseIdx + 200);
    assert.match(
        restoredCaseBody,
        /_restoredTabStateReceived\s*=\s*true;/,
        "case 'restoredTabState' must set _restoredTabStateReceived = true"
    );

    // Assertion 3: Unconditional _restoredPanelState assignment preserved in fetchRootsComplete body
    assert.match(
        fetchRootsBody,
        /if\s*\(\s*msg\.restoredTabState\s*\)\s*\{\s*_restoredPanelState\.panel/,
        "_restoredPanelState assignment must remain unconditional in fetchRootsComplete"
    );

    // Assertion 4: loadLocalTicketFiles contains ClickUp no-list synthetic dispatch early return
    const loadLocalIdx = planningJs.indexOf('function loadLocalTicketFiles()');
    assert.strictEqual(loadLocalIdx !== -1, true, 'loadLocalTicketFiles function must exist');
    const loadLocalEnd = planningJs.indexOf('function _requestTicketSyncStatuses()', loadLocalIdx);
    const loadLocalBody = planningJs.slice(loadLocalIdx, loadLocalEnd);

    assert.match(
        loadLocalBody,
        /if\s*\(\s*lastIntegrationProvider\s*===\s*'clickup'\s*&&\s*!effectiveListId\s*\)\s*\{[\s\S]*?unscopedPlaceholder:\s*true[\s\S]*?return;\s*\}/,
        "loadLocalTicketFiles must synthetically dispatch empty localTicketFilesListed with unscopedPlaceholder when ClickUp has no selected list"
    );

    // Assertion 5: Latch site in case 'localTicketFilesListed' is guarded by !msg.unscopedPlaceholder
    const localListedIdx = planningJs.indexOf("case 'localTicketFilesListed':");
    assert.strictEqual(localListedIdx !== -1, true, "case 'localTicketFilesListed': must exist");
    const localListedBody = planningJs.slice(localListedIdx, localListedIdx + 300);
    assert.match(
        localListedBody,
        /if\s*\(\s*!msg\.unscopedPlaceholder\s*\)\s*\{\s*ticketsLoadedOnce\s*=\s*true;\s*\}/,
        "ticketsLoadedOnce latch must be guarded by !msg.unscopedPlaceholder"
    );

    // Assertion 6: restoreTicketsStateForRoot contains _ticketsListedUnscoped re-issue check without modifying ticketsLoadedOnce
    const restoreTicketsIdx = planningJs.indexOf('function restoreTicketsStateForRoot(state)');
    assert.strictEqual(restoreTicketsIdx !== -1, true, 'restoreTicketsStateForRoot function must exist');
    const restoreTicketsEnd = planningJs.indexOf('function restoreTicketsState()', restoreTicketsIdx);
    const restoreTicketsBody = planningJs.slice(restoreTicketsIdx, restoreTicketsEnd);

    assert.match(
        restoreTicketsBody,
        /if\s*\(\s*_ticketsListedUnscoped\s*&&\s*currentScopeId\s*\)\s*\{\s*_ticketsListedUnscoped\s*=\s*false;\s*loadLocalTicketFiles\(\);\s*\}/,
        "restoreTicketsStateForRoot must re-issue loadLocalTicketFiles when previous list was unscoped and scope is now known"
    );
    assert.strictEqual(
        restoreTicketsBody.includes('ticketsLoadedOnce'),
        false,
        "restoreTicketsStateForRoot must not touch ticketsLoadedOnce"
    );

    // Assertion 7: PlanningPanelProvider fallback scan passes scopeId & skipSubtasks, backfill scan does not
    const providerListLocalIdx = providerTs.indexOf("case 'listLocalTicketFiles':");
    assert.strictEqual(providerListLocalIdx !== -1, true, "case 'listLocalTicketFiles': must exist");
    const providerListLocalEnd = providerTs.indexOf("case 'getTicketSyncStatuses':", providerListLocalIdx);
    const providerListLocalBody = providerTs.slice(providerListLocalIdx, providerListLocalEnd);

    assert.match(
        providerListLocalBody,
        /_scanLocalTicketFiles\s*\(\s*dir,\s*provider,\s*tickets,\s*\{\s*scopeId,\s*skipSubtasks:\s*true\s*\}\s*\)/,
        "Fallback scan call in listLocalTicketFiles must pass { scopeId, skipSubtasks: true }"
    );

    const backfillIdx = providerTs.indexOf('// Backfill/orphan scan');
    const backfillBody = providerTs.slice(backfillIdx !== -1 ? backfillIdx : 0, (backfillIdx !== -1 ? backfillIdx : 0) + 500);
    assert.strictEqual(
        /_scanLocalTicketFiles\s*\([^)]*\{\s*scopeId/.test(backfillBody),
        false,
        "Backfill scan call must NOT pass scopeId option"
    );

    // Assertion 8: Scoping warning log exists in PlanningPanelProvider DB loop
    assert.match(
        providerListLocalBody,
        /console\.warn\(`\[PlanningPanelProvider\] listLocalTicketFiles scoping hid all candidate files for \${provider}/,
        "PlanningPanelProvider listLocalTicketFiles must log a warning when scoping hides all candidate files"
    );
}

if (require.main === module) {
    testTicketsSidebarListScoping();
    console.log('testTicketsSidebarListScoping passed.');
}

module.exports = { testTicketsSidebarListScoping };
