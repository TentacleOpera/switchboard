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
    // Assert no ASSIGNMENT, not the absence of the identifier: the function carries an
    // explanatory comment naming ticketsLoadedOnce, so a substring check fails against
    // correct code (it did — this gate was red at HEAD).
    assert.strictEqual(
        /ticketsLoadedOnce\s*=/.test(restoreTicketsBody),
        false,
        "restoreTicketsStateForRoot must not assign ticketsLoadedOnce — the late re-issue must not re-open the double-fetch the latch prevents"
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

    // The backfill/orphan scan registers subtask files so _findTicketFilePath can still
    // resolve them — it must stay UNSCOPED. Anchored on the call itself, not on a comment:
    // an anchor comment that does not exist in the source slices the file header instead
    // and the negative passes vacuously no matter what the backfill call does.
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

    // Assertion 8: Scoping coverage warn AND its counters exist together, so the honesty
    // path cannot be dropped as "noise" while leaving the log line behind.
    assert.match(
        providerListLocalBody,
        /console\.warn\(`\[PlanningPanelProvider\] listLocalTicketFiles scoping hid all candidate files for \${provider}/,
        "PlanningPanelProvider listLocalTicketFiles must log a warning when scoping hides all candidate files"
    );
    for (const counter of ['totalCandidates', 'hiddenByScope', 'hiddenBySubtask']) {
        assert.ok(
            providerListLocalBody.includes(`${counter}++`),
            `listLocalTicketFiles must increment ${counter} so the coverage warn reports real counts`
        );
    }

    // Assertion 9: the coverage counts travel back on the response so the sidebar can
    // distinguish "this list has no tickets" from "these files need re-keying". An empty
    // sidebar that reads as "no tickets" is the one way this change ships a silent regression.
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
        planningJs,
        /_ticketsScopeCoverage\s*=\s*msg\.scopeCoverage\s*\|\|\s*null;/,
        'localTicketFilesListed handler must capture msg.scopeCoverage'
    );
    assert.match(
        planningJs,
        /don't carry a list id — Refetch this list to re-key them/,
        'the empty state must offer the re-key copy rather than a bare "No tasks found."'
    );
    // Linear scopes on `projectName:` and gets the same scopeCoverage counts, so the
    // re-key instruction must name the key the Linear user can actually fix.
    assert.match(
        planningJs,
        /don't carry a project name — Refetch this project to re-key them/,
        'the re-key copy must name projectName for Linear, not "list id"'
    );

    // Assertion 10: the no-list-selected state says so. Showing "No tasks found." to a
    // user who has selected nothing reads as "this list is empty" — the same
    // empty-is-not-correct failure the coverage warn exists to prevent, one level up.
    assert.match(
        planningJs,
        /_ticketsAwaitingListSelection\s*=\s*!!msg\.unscopedPlaceholder;/,
        "the localTicketFilesListed handler must record the unscopedPlaceholder marker"
    );
    assert.match(
        planningJs,
        /if\s*\(\s*_ticketsAwaitingListSelection\s*\)\s*\{\s*return\s+'Select a space and list to see its tickets\.';/,
        'the ClickUp no-list-selected placeholder must render the "Select a space and list" empty state'
    );

    // Assertion 11: BOTH provider renderers route through the shared copy helper. Wiring
    // it into one renderer only leaves the other silently reporting "no tickets".
    const clickUpRenderIdx = planningJs.indexOf('function renderTicketsClickUpList()');
    const linearRenderIdx = planningJs.indexOf('function renderTicketsLinearList()');
    assert.strictEqual(clickUpRenderIdx !== -1 && linearRenderIdx !== -1, true, 'both ticket list renderers must exist');
    for (const [name, startIdx, endNeedle] of [
        ['renderTicketsClickUpList', clickUpRenderIdx, 'function renderTicketsClickUpTaskDetail()'],
        ['renderTicketsLinearList', linearRenderIdx, 'function renderTicketsLinearTaskDetail()']
    ]) {
        const endIdx = planningJs.indexOf(endNeedle, startIdx);
        assert.strictEqual(endIdx !== -1, true, `expected to find ${endNeedle}`);
        assert.ok(
            planningJs.slice(startIdx, endIdx).includes('_ticketsEmptyStateCopy('),
            `${name} must render its empty state through _ticketsEmptyStateCopy`
        );
    }
}

if (require.main === module) {
    testTicketsSidebarListScoping();
    console.log('testTicketsSidebarListScoping passed.');
}

module.exports = { testTicketsSidebarListScoping };
