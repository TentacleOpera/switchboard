'use strict';

const assert = require('assert');

/**
 * Replicates the sorting logic from src/webview/kanban.html for non-planning columns.
 * V61: primary sort key is _colTs (column_entered_at) descending, with createdAt
 * descending as tiebreaker. _colTs falls back to _ts (lastActivity) for legacy rows
 * where columnEnteredAt is null/missing.
 */
function sortNonPlanningCards(items) {
    return [...items].sort((a, b) => {
        const colTsDiff = (b._colTs || 0) - (a._colTs || 0);
        if (colTsDiff !== 0) return colTsDiff;
        // Secondary tiebreaker: createdAt descending
        let createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        let createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (isNaN(createdA)) createdA = 0;
        if (isNaN(createdB)) createdB = 0;
        return createdB - createdA;
    });
}

async function testComparator() {
    console.log('Running kanban-sorting-timestamp-regression.test.js...');

    // Case 1: Different _colTs (columnEnteredAt)
    const items1 = [
        { id: 'older_col', _colTs: 1000, createdAt: '2026-05-01T10:00:00.000Z' },
        { id: 'newer_col', _colTs: 2000, createdAt: '2026-05-01T09:00:00.000Z' }
    ];
    const sorted1 = sortNonPlanningCards(items1);
    assert.strictEqual(sorted1[0].id, 'newer_col', 'Should sort by newest columnEnteredAt first');

    // Case 2: Same _colTs, different createdAt
    const items2 = [
        { id: 'older_plan', _colTs: 1000, createdAt: '2026-05-01T09:00:00.000Z' },
        { id: 'newer_plan', _colTs: 1000, createdAt: '2026-05-01T10:00:00.000Z' }
    ];
    const sorted2 = sortNonPlanningCards(items2);
    assert.strictEqual(sorted2[0].id, 'newer_plan', 'Should tiebreak with newest creation date first');

    // Case 3: Same _colTs, malformed createdAt — valid date should sort above invalid
    const items3 = [
        { id: 'plan1', _colTs: 1000, createdAt: 'invalid' },
        { id: 'plan2', _colTs: 1000, createdAt: '2026-05-01T10:00:00.000Z' }
    ];
    const sorted3 = sortNonPlanningCards(items3);
    assert.strictEqual(sorted3[0].id, 'plan2', 'Valid createdAt should sort above invalid (NaN→0)');
    assert.strictEqual(sorted3[1].id, 'plan1');

    // Case 4: Missing _colTs (should be 0)
    const items4 = [
        { id: 'no_colts', createdAt: '2026-05-01T10:00:00.000Z' }, // _colTs undefined -> 0
        { id: 'with_colts', _colTs: 500, createdAt: '2026-05-01T09:00:00.000Z' }
    ];
    const sorted4 = sortNonPlanningCards(items4);
    assert.strictEqual(sorted4[0].id, 'with_colts', 'Should sort cards with columnEnteredAt above those without');

    // Case 5: _colTs beats _ts — the core V61 regression. A card with a more recent
    // lastActivity (_ts) but older columnEnteredAt (_colTs) must sort below a card
    // that was moved to the column more recently.
    const items5 = [
        { id: 'batch_bumped', _ts: 5000, _colTs: 1000, createdAt: '2026-06-01T00:00:00.000Z' },
        { id: 'recently_moved', _ts: 3000, _colTs: 4000, createdAt: '2026-08-01T00:00:00.000Z' }
    ];
    const sorted5 = sortNonPlanningCards(items5);
    assert.strictEqual(sorted5[0].id, 'recently_moved', 'columnEnteredAt should beat lastActivity');

    console.log('✅ kanban-sorting-timestamp-regression.test.js passed');
}

testComparator().catch(err => {
    console.error('❌ kanban-sorting-timestamp-regression.test.js failed:');
    console.error(err);
    process.exit(1);
});
