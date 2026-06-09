/**
 * Regression test for non-planning column sorting in the webview (src/webview/kanban.html).
 *
 * Runs standalone:
 *   node src/test/kanban-non-planning-sort.test.js
 */

'use strict';

const assert = require('assert');

function sortNonPlanningColumn(items) {
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

function mk(id, lastActivity, createdAt) {
    const t = lastActivity ? new Date(lastActivity).getTime() : NaN;
    return {
        id,
        lastActivity: lastActivity || '',
        createdAt: createdAt || '',
        _ts: isNaN(t) ? 0 : t
    };
}

let pass = 0;
let fail = 0;
const failures = [];

function t(label, fn) {
    try {
        fn();
        pass += 1;
        console.log(`  PASS ${label}`);
    } catch (err) {
        fail += 1;
        failures.push({ label, message: err.message });
        console.error(`  FAIL ${label}: ${err.message}`);
    }
}

t('primary sort by _ts descending (most recent activity first)', () => {
    const cards = [
        mk('card1', '2026-05-19T10:00:00Z', '2026-05-19T09:00:00Z'),
        mk('card2', '2026-05-19T12:00:00Z', '2026-05-19T08:00:00Z'),
        mk('card3', '2026-05-19T11:00:00Z', '2026-05-19T07:00:00Z')
    ];
    const sorted = sortNonPlanningColumn(cards);
    assert.deepStrictEqual(sorted.map(c => c.id), ['card2', 'card3', 'card1']);
});

t('secondary sort by createdAt descending when _ts is identical', () => {
    const cards = [
        mk('card1', '2026-05-19T10:00:00Z', '2026-05-19T07:00:00Z'),
        mk('card2', '2026-05-19T10:00:00Z', '2026-05-19T09:00:00Z'),
        mk('card3', '2026-05-19T10:00:00Z', '2026-05-19T08:00:00Z')
    ];
    const sorted = sortNonPlanningColumn(cards);
    assert.deepStrictEqual(sorted.map(c => c.id), ['card2', 'card3', 'card1']);
});

t('secondary sort by createdAt descending when _ts is missing (0)', () => {
    const cards = [
        mk('card1', null, '2026-05-19T07:00:00Z'),
        mk('card2', null, '2026-05-19T09:00:00Z'),
        mk('card3', null, '2026-05-19T08:00:00Z')
    ];
    const sorted = sortNonPlanningColumn(cards);
    assert.deepStrictEqual(sorted.map(c => c.id), ['card2', 'card3', 'card1']);
});

t('invalid date handling (NaN safety) falls back to 0', () => {
    const cards = [
        mk('card1', null, 'invalid-date'),
        mk('card2', null, '2026-05-19T09:00:00Z'),
        mk('card3', null, '')
    ];
    const sorted = sortNonPlanningColumn(cards);
    // card2 (valid date) should come first, card1 and card3 are both 0 (invalid/missing)
    assert.strictEqual(sorted[0].id, 'card2');
});

console.log(`\n[kanban-non-planning-sort] passed=${pass} failed=${fail}`);
if (fail > 0) {
    process.exit(1);
}
process.exit(0);
