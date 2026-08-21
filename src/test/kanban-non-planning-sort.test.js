/**
 * Regression test for non-planning column sorting in the webview (src/webview/kanban.html).
 *
 * V61: the primary sort key changed from _ts (lastActivity / updated_at) to
 * _colTs (columnEnteredAt / column_entered_at). The board now sorts by "when
 * was this card moved to its current column" — most recent first — so a batch
 * operation that bumps updated_at on 100 cards can no longer reshuffle the
 * column. _ts is retained as a fallback for legacy rows where columnEnteredAt
 * is null/missing (pre-V61 databases that haven't been migrated yet).
 *
 * Runs standalone:
 *   node src/test/kanban-non-planning-sort.test.js
 */

'use strict';

const assert = require('assert');

/**
 * Replicates the sort comparator from kanban.html's renderBoard function.
 * Primary: _colTs descending (column_entered_at). Falls back to _ts when
 * _colTs is absent (legacy rows). Secondary: createdAt descending.
 */
function sortNonPlanningColumn(items) {
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

/**
 * Build a card object matching the shape kanban.html constructs in its
 * bucketing loop: _ts from lastActivity, _colTs from columnEnteredAt
 * (falling back to _ts when columnEnteredAt is null/missing).
 */
function mk(id, lastActivity, createdAt, columnEnteredAt) {
    const t = lastActivity ? new Date(lastActivity).getTime() : NaN;
    const ts = isNaN(t) ? 0 : t;
    const colTs = columnEnteredAt
        ? new Date(columnEnteredAt).getTime()
        : NaN;
    return {
        id,
        lastActivity: lastActivity || '',
        createdAt: createdAt || '',
        columnEnteredAt: columnEnteredAt || null,
        _ts: ts,
        _colTs: isNaN(colTs) ? ts : colTs
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

t('primary sort by _colTs descending (most recently moved to column first)', () => {
    const cards = [
        mk('card1', '2026-05-19T10:00:00Z', '2026-05-19T09:00:00Z', '2026-05-19T10:00:00Z'),
        mk('card2', '2026-05-19T12:00:00Z', '2026-05-19T08:00:00Z', '2026-05-19T12:00:00Z'),
        mk('card3', '2026-05-19T11:00:00Z', '2026-05-19T07:00:00Z', '2026-05-19T11:00:00Z')
    ];
    const sorted = sortNonPlanningColumn(cards);
    assert.deepStrictEqual(sorted.map(c => c.id), ['card2', 'card3', 'card1']);
});

t('_colTs beats _ts — a card with older lastActivity but newer columnEnteredAt sorts first', () => {
    // This is the core regression: a batch operation bumped updated_at on card_old
    // but card_new was moved to the column more recently. card_new must sort first.
    const cards = [
        mk('card_old', '2026-08-20T22:58:00Z', '2026-06-25T01:00:00Z', '2026-08-01T10:00:00Z'),
        mk('card_new', '2026-08-20T12:24:00Z', '2026-08-18T20:50:00Z', '2026-08-20T12:24:00Z')
    ];
    const sorted = sortNonPlanningColumn(cards);
    // card_new was moved to column at 12:24, card_old at 10:00 on Aug 1
    // card_new sorts first despite card_old having a more recent lastActivity
    assert.strictEqual(sorted[0].id, 'card_new');
});

t('secondary sort by createdAt descending when _colTs is identical', () => {
    const cards = [
        mk('card1', '2026-05-19T10:00:00Z', '2026-05-19T07:00:00Z', '2026-05-19T10:00:00Z'),
        mk('card2', '2026-05-19T10:00:00Z', '2026-05-19T09:00:00Z', '2026-05-19T10:00:00Z'),
        mk('card3', '2026-05-19T10:00:00Z', '2026-05-19T08:00:00Z', '2026-05-19T10:00:00Z')
    ];
    const sorted = sortNonPlanningColumn(cards);
    assert.deepStrictEqual(sorted.map(c => c.id), ['card2', 'card3', 'card1']);
});

t('legacy fallback: _colTs absent falls back to _ts (lastActivity)', () => {
    // Pre-V61 rows have no columnEnteredAt — _colTs falls back to _ts
    const cards = [
        mk('card1', '2026-05-19T10:00:00Z', '2026-05-19T09:00:00Z', null),
        mk('card2', '2026-05-19T12:00:00Z', '2026-05-19T08:00:00Z', null),
        mk('card3', '2026-05-19T11:00:00Z', '2026-05-19T07:00:00Z', null)
    ];
    const sorted = sortNonPlanningColumn(cards);
    // Falls back to _ts descending: card2 (12:00) > card3 (11:00) > card1 (10:00)
    assert.deepStrictEqual(sorted.map(c => c.id), ['card2', 'card3', 'card1']);
});

t('mixed: cards with columnEnteredAt sort above legacy cards that only have _ts', () => {
    // A card with columnEnteredAt should sort by that; a legacy card falls back
    // to _ts. If the columnEnteredAt is newer than the legacy _ts, it wins.
    const cards = [
        mk('legacy', '2026-08-20T22:58:00Z', '2026-06-25T01:00:00Z', null), // _colTs = _ts = 22:58
        mk('migrated', '2026-08-20T12:24:00Z', '2026-08-18T20:50:00Z', '2026-08-21T09:00:00Z') // _colTs = 09:00 Aug 21
    ];
    const sorted = sortNonPlanningColumn(cards);
    // migrated has _colTs = Aug 21 09:00, legacy has _colTs = Aug 20 22:58
    // migrated sorts first
    assert.strictEqual(sorted[0].id, 'migrated');
});

t('invalid date handling (NaN safety) falls back to 0', () => {
    const cards = [
        mk('card1', null, 'invalid-date', null),
        mk('card2', null, '2026-05-19T09:00:00Z', null),
        mk('card3', null, '', null)
    ];
    const sorted = sortNonPlanningColumn(cards);
    // All have _colTs = _ts = 0, so sort by createdAt: card2 > card3 = card1
    assert.strictEqual(sorted[0].id, 'card2');
});

console.log(`\n[kanban-non-planning-sort] passed=${pass} failed=${fail}`);
if (fail > 0) {
    process.exit(1);
}
process.exit(0);
