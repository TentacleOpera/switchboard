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
    expectRegex(
        /const\s+eligibleCards\s*=\s*this\._getEligibleAutobanCards\(cardsInColumn\);[\s\S]*const\s+selectedCards\s*=\s*await\s+this\._selectAutobanPlanReviewedCards\(workspaceRoot,\s*eligibleCards,\s*batchSize\);[\s\S]*await\s+this\._stopAutobanIfNoValidTicketsRemain\(workspaceRoot\);/s,
        'Expected autoban no-work detection to reuse the same eligibility helpers used for dispatch filtering.'
    );

    console.log('autoban no-valid-tickets regression test passed');
}

try {
    run();
} catch (error) {
    console.error('autoban no-valid-tickets regression test failed:', error);
    process.exit(1);
}
