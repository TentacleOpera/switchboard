const fs = require('fs');
const path = require('path');
const assert = require('assert');

function testKanbanRenderGuardContract() {
    const kanbanHtmlPath = path.join(__dirname, '../webview/kanban.html');
    const kanbanHtml = fs.readFileSync(kanbanHtmlPath, 'utf8');

    // 1. workingChanged is gone
    assert.strictEqual(
        kanbanHtml.includes('workingChanged'),
        false,
        'kanban.html must not contain workingChanged'
    );

    // 2. The suppressed branch does not adopt the payload directly as currentCards = nextCards
    const updateBoardIdx = kanbanHtml.indexOf("case 'updateBoard':");
    assert.strictEqual(updateBoardIdx !== -1, true, "case 'updateBoard': must exist");
    const updateBoardEnd = kanbanHtml.indexOf("case 'settingResult':", updateBoardIdx);
    const updateBoardBody = kanbanHtml.slice(updateBoardIdx, updateBoardEnd);
    const optimisticActiveBranchIdx = updateBoardBody.indexOf("if (optimisticActive) {");
    const optimisticActiveBranchEnd = updateBoardBody.indexOf("} else {", optimisticActiveBranchIdx);
    const optimisticBranchBody = updateBoardBody.slice(optimisticActiveBranchIdx, optimisticActiveBranchEnd);
    assert.strictEqual(
        optimisticBranchBody.includes('currentCards = nextCards'),
        false,
        'updateBoard optimisticActive branch must not contain currentCards = nextCards'
    );

    // 3. moveCards does not rebuild the board with renderBoard(currentCards)
    const moveCardsIdx = kanbanHtml.indexOf("case 'moveCards':");
    assert.strictEqual(moveCardsIdx !== -1, true, "case 'moveCards': must exist");
    const moveCardsEnd = kanbanHtml.indexOf("case 'moveCardsFailed':", moveCardsIdx);
    const moveCardsBody = kanbanHtml.slice(moveCardsIdx, moveCardsEnd);
    assert.strictEqual(
        moveCardsBody.includes('renderBoard('),
        false,
        'moveCards handler must not call renderBoard'
    );
    assert.strictEqual(
        moveCardsBody.includes('moveCardElements('),
        true,
        'moveCards handler must reference moveCardElements primitive'
    );

    // 4. moveCardsFailed does not rebuild the board with renderBoard
    const moveFailedIdx = kanbanHtml.indexOf("case 'moveCardsFailed':");
    assert.strictEqual(moveFailedIdx !== -1, true, "case 'moveCardsFailed': must exist");
    const moveFailedEnd = kanbanHtml.indexOf("case 'updateBoard':", moveFailedIdx);
    const moveFailedBody = kanbanHtml.slice(moveFailedIdx, moveFailedEnd);
    assert.strictEqual(
        moveFailedBody.includes('renderBoard('),
        false,
        'moveCardsFailed handler must not call renderBoard'
    );
    assert.strictEqual(
        moveFailedBody.includes('moveCardElements('),
        true,
        'moveCardsFailed handler must reference moveCardElements primitive'
    );

    // 5. moveCards compares column before adding entry to move
    assert.strictEqual(
        moveCardsBody.includes('card.column !== targetCol'),
        true,
        'moveCards must check card.column !== targetCol'
    );

    // 6. Guard arming uses armOptimisticGuard helper
    assert.strictEqual(
        kanbanHtml.includes('function armOptimisticGuard('),
        true,
        'armOptimisticGuard function must exist'
    );
    const matchesArming = kanbanHtml.match(/optimisticMoveUntil\s*=\s*Date\.now\(\)\s*\+/g) || [];
    assert.strictEqual(
        matchesArming.length,
        1,
        'optimisticMoveUntil = Date.now() + should only appear once inside armOptimisticGuard'
    );

    // 7. Every clear-point uses clearOptimisticGuard
    const matchesClear = kanbanHtml.match(/optimisticMoveUntil\s*=\s*0;/g) || [];
    assert.strictEqual(
        matchesClear.length,
        2,
        'optimisticMoveUntil = 0 should appear only in initial declaration and clearOptimisticGuard()'
    );

    // 8. allCards is overlaid via applyPendingOptimisticMoves
    assert.strictEqual(
        updateBoardBody.includes('allCards = applyPendingOptimisticMoves('),
        true,
        'updateBoard must apply pending optimistic moves to allCards'
    );

    // 9. Positional signature function exists
    assert.strictEqual(
        kanbanHtml.includes('function buildPositionSignature('),
        true,
        'buildPositionSignature function must exist'
    );

    console.log('testKanbanRenderGuardContract passed all assertions successfully.');
}

module.exports = { testKanbanRenderGuardContract };

if (require.main === module) {
    testKanbanRenderGuardContract();
}
