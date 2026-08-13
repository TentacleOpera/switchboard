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
    // Window is generous on purpose: the arm now opens with the cross-panel scope
    // guard (`if (!_isForThisPanel(message)) { break; }`), so a tight 300-char slice
    // truncates before the latch and fails on a change that did not touch the latch.
    const localListedBody = ticketsJs.slice(localListedIdx, localListedIdx + 600);
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
        // `this._scoped(` is the cross-panel reply stamp — optional here because this
        // assertion is about scopeCoverage travelling back, not about the stamp.
        /const res = (?:this\._scoped\()?\{ type: 'localTicketFilesListed', provider, tickets, \.\.\.\(scopeCoverage \?/,
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

    // ── Assertion 12: the sync badge has FOUR inputs, not three. ─────────────────
    // `undefined` means "not fetched yet" and must not fall through to the `local`
    // verdict — that fallback is what made every drill-down subtask card claim it was
    // local-only when its status had simply never been requested.
    const badgeIdx = ticketsJs.indexOf('function _ticketSyncBadge(');
    assert.notStrictEqual(badgeIdx, -1, '_ticketSyncBadge must exist in tickets.js');
    const badgeBody = ticketsJs.slice(badgeIdx, ticketsJs.indexOf('\n    }', badgeIdx));
    assert.ok(
        badgeBody.includes("=== 'local-only'"),
        "_ticketSyncBadge must compare against 'local-only' explicitly — a bare fallback to the "
        + 'local badge cannot distinguish "not fetched yet" from "genuinely never pushed"'
    );
    assert.ok(
        /ticket-sync-pending/.test(badgeBody),
        '_ticketSyncBadge must render a distinct pending state for an unfetched status'
    );
    assert.ok(
        fs.readFileSync(path.join(__dirname, '../webview/tickets.html'), 'utf8').includes('.ticket-sync-pending'),
        'tickets.html must style .ticket-sync-pending, or the pending badge renders unstyled'
    );

    // Assertion 13: drill-down subtask ids ride the SAME scope-stamped request. A second,
    // unscoped request would be discarded by _isForThisPanel on the way back.
    const reqIdx = ticketsJs.indexOf('function _requestTicketSyncStatuses()');
    assert.notStrictEqual(reqIdx, -1, '_requestTicketSyncStatuses must exist in tickets.js');
    const reqBody = ticketsJs.slice(reqIdx, ticketsJs.indexOf('\n    }', reqIdx));
    assert.ok(
        reqBody.includes('_drillDownSubtasks'),
        '_requestTicketSyncStatuses must fold drill-down subtask ids into its id list'
    );
    assert.strictEqual(
        /if \(!issues\.length\) return;/.test(reqBody), false,
        'the top-level-only early return must be gone — with an empty filtered list and an active '
        + 'drill-down it skipped the subtask request entirely'
    );

    // Assertion 14: the re-request inside _maybeEnterDrillDown must come AFTER
    // `_drillDownProvider = provider`. _isDrillDownActive gates on that variable, so one
    // line too early sends zero subtask ids and the bug survives its own fix.
    const drillIdx = ticketsJs.indexOf('function _maybeEnterDrillDown(');
    assert.notStrictEqual(drillIdx, -1, '_maybeEnterDrillDown must exist in tickets.js');
    const drillBody = ticketsJs.slice(drillIdx, ticketsJs.indexOf('\n    }', ticketsJs.indexOf('_drillDownParentTitle =', drillIdx)));
    const providerAssignIdx = drillBody.indexOf('_drillDownProvider = provider');
    const reqCallIdx = drillBody.indexOf('_requestTicketSyncStatuses()');
    assert.notStrictEqual(providerAssignIdx, -1, '_maybeEnterDrillDown must set _drillDownProvider');
    assert.notStrictEqual(reqCallIdx, -1, '_maybeEnterDrillDown must re-request sync statuses for the new subtask ids');
    assert.ok(
        reqCallIdx > providerAssignIdx,
        '_requestTicketSyncStatuses() must be called AFTER _drillDownProvider = provider'
    );

    // Assertion 15: the response arm patches the drill-down array itself (it is a separate
    // array the sidebar renders from, and it survives subtask-detail loads), and the
    // local-file rebuild does not wipe statuses already resolved.
    const syncArmIdx = ticketsJs.indexOf("case 'ticketSyncStatusesLoaded': {");
    assert.notStrictEqual(syncArmIdx, -1, "case 'ticketSyncStatusesLoaded' must exist in tickets.js");
    const syncArm = ticketsJs.slice(syncArmIdx, ticketsJs.indexOf('\n            }', syncArmIdx));
    assert.ok(
        /_drillDownSubtasks = _drillDownSubtasks\.map/.test(syncArm),
        'ticketSyncStatusesLoaded must splice statuses back into _drillDownSubtasks'
    );
    const listArmIdx = ticketsJs.indexOf("case 'localTicketFilesListed': {");
    const listArm = ticketsJs.slice(listArmIdx, ticketsJs.indexOf("case 'localTicketFileRead':", listArmIdx));
    assert.strictEqual(
        /syncStatus: t\.syncStatus,/.test(listArm), false,
        'the local-file rebuild must not carry a bare `syncStatus: t.syncStatus` — the lister emits '
        + 'no syncStatus, so it wipes every status already resolved and the pending badge sticks'
    );
    assert.ok(
        /prevSync/.test(listArm) && /_requestTicketSyncStatuses\(\)/.test(listArm),
        'the local-file rebuild must preserve known statuses and re-request the unknown ones'
    );

    // ── Subtask-count chip + explicit drill-down (feature 25086852) ─────────

    // Assertion 16: the child tally is a FIRST pass. The main loop emits parents as it
    // walks, so a parent visited before its children would ship a count of zero.
    const tallyIdx = providerListLocalBody.indexOf('const subtaskCounts = new Map<string, number>()');
    const mainLoopIdx = providerListLocalBody.indexOf('for (const dbT of dbTickets) {\n                                if (dbT.sourceId === provider) {');
    assert.notStrictEqual(tallyIdx, -1, 'listLocalTicketFiles must build a subtaskCounts map');
    assert.notStrictEqual(mainLoopIdx, -1, 'listLocalTicketFiles main emit loop must exist');
    assert.ok(tallyIdx < mainLoopIdx, 'the subtaskCounts tally must complete BEFORE the emit loop');
    assert.ok(
        /subtaskCount: subtaskCounts\.get\(ticketId\) \|\| 0/.test(providerListLocalBody),
        'the DB-backed push must carry subtaskCount, keyed by the same id the card uses'
    );

    // Assertion 17: the scan fallback tallies from an UNFILTERED scan — the filtered one
    // drops children (skipSubtasks) before they can be counted.
    assert.ok(
        /_scanLocalTicketFiles\(dir, provider, allForCounting\)/.test(providerListLocalBody),
        'the fallback must scan unfiltered to tally children'
    );
    assert.ok(
        /t\.subtaskCount = fallbackCounts\.get\(t\.id\) \|\| 0/.test(providerListLocalBody),
        'the fallback must stamp subtaskCount onto the listed tickets'
    );

    // Assertion 18: both webview mapping arms carry the field through, or the chip never
    // renders regardless of what the backend counted.
    assert.strictEqual(
        (listArm.match(/subtaskCount: t\.subtaskCount/g) || []).length, 2,
        'both the ClickUp and Linear mapping arms must carry subtaskCount'
    );

    // Assertion 19: selecting a card must NOT arm drill-down. That implicit arming is the
    // bug — it replaced the list the user was working down, a beat after the click.
    const containerHandlerIdx = ticketsJs.indexOf("document.getElementById('tickets-issues-container')?.addEventListener('click'");
    assert.notStrictEqual(containerHandlerIdx, -1, 'the delegated card-click handler must exist');
    // Bound at the keydown registration, not at #tickets-create: the chip's Enter/Space
    // handler legitimately arms _pendingDrillDownParentId, and a window that swallows it
    // would fail assertion 19 for the wrong reason.
    const containerHandler = ticketsJs.slice(containerHandlerIdx, ticketsJs.indexOf("addEventListener('keydown'", containerHandlerIdx));
    const cardFallbackIdx = containerHandler.indexOf("const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]')");
    assert.notStrictEqual(cardFallbackIdx, -1, 'the catch-all card branch must exist');
    assert.strictEqual(
        /_pendingDrillDownParentId\s*=/.test(containerHandler.slice(cardFallbackIdx)), false,
        'the catch-all card branch must not arm _pendingDrillDownParentId — selection is not navigation'
    );

    // Assertion 20: the chip branch must be registered ABOVE the [data-edit-status] branch.
    // The chip lives inside that row and that branch selects, opens the status modal and
    // returns — so a chip below it is swallowed and opens the wrong modal.
    const chipIdx = containerHandler.indexOf("e.target.closest('[data-subtask-count-ticket-id]')");
    const editStatusIdx = containerHandler.indexOf("e.target.closest('[data-edit-status]')");
    assert.notStrictEqual(chipIdx, -1, 'the subtask-count chip branch must exist');
    assert.notStrictEqual(editStatusIdx, -1, 'the [data-edit-status] branch must exist');
    assert.ok(chipIdx < editStatusIdx, 'the chip branch must be registered above the [data-edit-status] branch');

    // Assertion 21: _maybeEnterDrillDown's pending-id guard is now load-bearing — it is the
    // only thing stopping the detail-loaded arms from drilling on an ordinary selection.
    assert.ok(
        /if \(!id \|\| _pendingDrillDownParentId !== id\) return;/.test(ticketsJs),
        '_maybeEnterDrillDown must keep its _pendingDrillDownParentId guard'
    );

    // Assertion 22: Move is a direct card button; the card renderers carry no overflow menu
    // and nothing emits the dead + Subtask attribute any more.
    const clickUpCardIdx = ticketsJs.indexOf('function _renderClickUpTicketCard');
    const linearCardEnd = ticketsJs.indexOf('function _ticketsEmptyStateCopy', clickUpCardIdx);
    const cardRenderers = ticketsJs.slice(clickUpCardIdx, linearCardEnd);
    assert.strictEqual(
        /overflow-menu/.test(cardRenderers), false,
        'sidebar ticket cards must not render an overflow menu'
    );
    assert.strictEqual(
        (cardRenderers.match(/data-move-ticket-id/g) || []).length, 2,
        'both card renderers must render a direct Move button'
    );
    assert.strictEqual(
        /data-add-subtask-ticket-id/.test(ticketsJs), false,
        'the card + Subtask duplicate is gone; the control-strip #btn-add-subtask is the route'
    );

    // Assertion 23: a Move click must early-return before the catch-all card branch, or it
    // also selects the ticket (the container bubbles before the document-level listener,
    // so that listener\'s stopPropagation cannot prevent it).
    const moveGuardIdx = containerHandler.indexOf("e.target.closest('[data-move-ticket-id]')");
    assert.notStrictEqual(moveGuardIdx, -1, 'the container handler must early-return on a Move click');
    assert.ok(moveGuardIdx < cardFallbackIdx, 'the Move early return must precede the catch-all card branch');
}

if (require.main === module) {
    testTicketsSidebarListScoping();
    console.log('testTicketsSidebarListScoping passed.');
}

module.exports = { testTicketsSidebarListScoping };
