'use strict';

const assert = require('assert');

function buildBoardSignature(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return '';
    return cards
        .map(card => `${card.workspaceRoot || ''}|${card.sessionId}|${card.column}|${card.topic || ''}|${card.planFile || ''}|${card.complexity || 'Unknown'}|${card.lastActivity || ''}`)
        .sort()
        .join('||');
}

function sortCardsOldestFirst(cards) {
    return [...cards].sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''));
}

async function run() {
    const cards = [
        { sessionId: 'b', column: 'CODE REVIEWED', topic: 'B', planFile: 'b.md', complexity: 'Unknown', workspaceRoot: 'ws', lastActivity: '2026-03-17T02:00:00.000Z' },
        { sessionId: 'a', column: 'CODE REVIEWED', topic: 'A', planFile: 'a.md', complexity: 'Unknown', workspaceRoot: 'ws', lastActivity: '2026-03-17T01:00:00.000Z' }
    ];

    const ordered = sortCardsOldestFirst(cards);
    assert.deepStrictEqual(ordered.map(card => card.sessionId), ['a', 'b'], 'cards should render oldest-first by lastActivity');

    const before = buildBoardSignature(cards);
    const after = buildBoardSignature([
        { ...cards[0], lastActivity: '2026-03-17T03:00:00.000Z' },
        cards[1]
    ]);
    assert.notStrictEqual(before, after, 'board signature must change when lastActivity changes so the board rerenders');

    console.log('kanban ordering regression test passed');
}

run().catch((error) => {
    console.error('kanban ordering regression test failed:', error);
    process.exit(1);
});
