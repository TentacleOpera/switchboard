'use strict';

const assert = require('assert');

/**
 * Replicates the sorting logic from src/webview/kanban.html for non-planning columns.
 * This test ensures that plans are sorted by most-recent activity (_ts) first,
 * with newest creation date (createdAt) as a tiebreaker.
 */
function sortNonPlanningCards(items) {
    return [...items].sort((a, b) => {
        const tsDiff = (b._ts || 0) - (a._ts || 0);
        if (tsDiff !== 0) return tsDiff;
        // Secondary tiebreaker: createdAt descending (for cards with no lastActivity/same lastActivity)
        let createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        let createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (isNaN(createdA)) createdA = 0;
        if (isNaN(createdB)) createdB = 0;
        return createdB - createdA;
    });
}

async function testComparator() {
    console.log('Running kanban-sorting-timestamp-regression.test.js...');

    // Case 1: Different _ts (lastActivity)
    const items1 = [
        { id: 'older_activity', _ts: 1000, createdAt: '2026-05-01T10:00:00.000Z' },
        { id: 'newer_activity', _ts: 2000, createdAt: '2026-05-01T09:00:00.000Z' } // Created earlier but more recent activity
    ];
    const sorted1 = sortNonPlanningCards(items1);
    assert.strictEqual(sorted1[0].id, 'newer_activity', 'Should sort by newest activity first');

    // Case 2: Same _ts, different createdAt
    const items2 = [
        { id: 'older_plan', _ts: 1000, createdAt: '2026-05-01T09:00:00.000Z' },
        { id: 'newer_plan', _ts: 1000, createdAt: '2026-05-01T10:00:00.000Z' }
    ];
    const sorted2 = sortNonPlanningCards(items2);
    assert.strictEqual(sorted2[0].id, 'newer_plan', 'Should tiebreak with newest creation date first');

    // Case 3: Same _ts, malformed createdAt — valid date should sort above invalid
    const items3 = [
        { id: 'plan1', _ts: 1000, createdAt: 'invalid' },
        { id: 'plan2', _ts: 1000, createdAt: '2026-05-01T10:00:00.000Z' }
    ];
    const sorted3 = sortNonPlanningCards(items3);
    assert.strictEqual(sorted3[0].id, 'plan2', 'Valid createdAt should sort above invalid (NaN→0)');
    assert.strictEqual(sorted3[1].id, 'plan1');

    // Case 4: Missing _ts (should be 0)
    const items4 = [
        { id: 'no_ts', createdAt: '2026-05-01T10:00:00.000Z' }, // _ts will be undefined -> 0
        { id: 'with_ts', _ts: 500, createdAt: '2026-05-01T09:00:00.000Z' }
    ];
    const sorted4 = sortNonPlanningCards(items4);
    assert.strictEqual(sorted4[0].id, 'with_ts', 'Should sort cards with activity above those without');

    console.log('✅ kanban-sorting-timestamp-regression.test.js passed');
}

testComparator().catch(err => {
    console.error('❌ kanban-sorting-timestamp-regression.test.js failed:');
    console.error(err);
    process.exit(1);
});
