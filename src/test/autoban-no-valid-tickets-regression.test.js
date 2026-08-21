'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');

function expectRegex(regex, message) {
    assert.match(providerSource, regex, message);
}

function run() {
    expectRegex(
        /private\s+async\s+_stopAutobanForNoValidTickets\(\):\s+Promise<void>\s*\{\s*await\s+this\._stopAutobanWithMessage\('Autoban stopped: no more valid tickets remain in enabled columns\.',\s*'info'\);\s*\}/s,
        'Expected a dedicated informational autoban stop path for the no-valid-tickets condition.'
    );
    expectRegex(
        /private\s+async\s+_autobanHasEligibleCardsInEnabledColumns\(workspaceRoot:\s*string\):\s*Promise<boolean>\s*\{[\s\S]*const\s+enabledColumns\s*=\s*this\._getEnabledAutobanSourceColumns\(\);[\s\S]*await\s+this\._collectKanbanCardsInColumns\(workspaceRoot,\s*enabledColumns\);[\s\S]*await\s+this\._autobanColumnHasEligibleCards\(column,\s*cardsByColumn\.get\(column\)\s*\|\|\s*\[\],\s*workspaceRoot\)/s,
        'Expected autoban no-work detection to scan all enabled columns before stopping.'
    );
    // The run-sheet tick that used to chain
    // _getEligibleAutobanCards → _selectAutobanPlanReviewedCards →
    // _stopAutobanIfNoValidTicketsRemain is deleted; the schedule pops the
    // STAGING session queue instead. The invariant the old assertion protected
    // — no-work detection must use the SAME predicate the dispatch path uses,
    // or the sweep stops the engine while dispatchable work exists — now lands
    // on the queue. Staging five plans into STAGING with CREATED and PLAN
    // REVIEWED empty must NOT stop the schedule.
    expectRegex(
        /private\s+async\s+_autobanHasStagedQueueCards\(workspaceRoot:\s*string\):\s*Promise<boolean>\s*\{[\s\S]*kanbanColumn\s*===\s*'STAGING'[\s\S]*!p\.dispatchedAt[\s\S]*!p\.featureId/s,
        'Expected a staged-queue check using the queue pop\'s own predicate (STAGING, un-dispatched, non-subtask).'
    );
    expectRegex(
        /private\s+async\s+_stopAutobanIfNoValidTicketsRemain\(workspaceRoot:\s*string\):\s*Promise<boolean>\s*\{[\s\S]*await\s+this\._autobanHasStagedQueueCards\(workspaceRoot\)[\s\S]*await\s+this\._autobanHasEligibleCardsInEnabledColumns\(workspaceRoot\)[\s\S]*await\s+this\._stopAutobanForNoValidTickets\(\);/s,
        'Expected the empty-column sweep to consult the STAGING queue BEFORE stopping the schedule.'
    );

    console.log('autoban no-valid-tickets regression test passed');
}

try {
    run();
} catch (error) {
    console.error('autoban no-valid-tickets regression test failed:', error);
    process.exit(1);
}
