const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Every renderBoard( call inside a move handler must come AFTER the handler has consulted
// optimisticMoveUntil. A rebuild ahead of that check is the unguarded full redraw that
// stomps an in-flight drop animation and reverts an optimistic move.
function assertRenderBoardIsGuardGated(handlerBody, handlerName) {
    const guardIdx = handlerBody.indexOf('optimisticMoveUntil');
    let searchFrom = 0;
    for (;;) {
        const renderIdx = handlerBody.indexOf('renderBoard(', searchFrom);
        if (renderIdx === -1) return;
        assert.strictEqual(
            guardIdx !== -1 && guardIdx < renderIdx,
            true,
            `${handlerName} must check optimisticMoveUntil before any renderBoard( call`
        );
        searchFrom = renderIdx + 1;
    }
}

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

    // 3. moveCards moves elements, and never rebuilds the board while the guard is armed.
    //    A rebuild is still the correct repair once the window has closed (card markup is
    //    column-dependent), so the assertion is on ORDER: the guard check must gate it.
    const moveCardsIdx = kanbanHtml.indexOf("case 'moveCards':");
    assert.strictEqual(moveCardsIdx !== -1, true, "case 'moveCards': must exist");
    const moveCardsEnd = kanbanHtml.indexOf("case 'moveCardsFailed':", moveCardsIdx);
    const moveCardsBody = kanbanHtml.slice(moveCardsIdx, moveCardsEnd);
    assert.strictEqual(
        moveCardsBody.includes('moveCardElements('),
        true,
        'moveCards handler must reference moveCardElements primitive'
    );
    assertRenderBoardIsGuardGated(moveCardsBody, 'moveCards');

    // 4. moveCardsFailed: same contract.
    const moveFailedIdx = kanbanHtml.indexOf("case 'moveCardsFailed':");
    assert.strictEqual(moveFailedIdx !== -1, true, "case 'moveCardsFailed': must exist");
    const moveFailedEnd = kanbanHtml.indexOf("case 'updateBoard':", moveFailedIdx);
    const moveFailedBody = kanbanHtml.slice(moveFailedIdx, moveFailedEnd);
    assert.strictEqual(
        moveFailedBody.includes('moveCardElements('),
        true,
        'moveCardsFailed handler must reference moveCardElements primitive'
    );
    assertRenderBoardIsGuardGated(moveFailedBody, 'moveCardsFailed');

    // 5. moveCards compares column before adding entry to move
    assert.strictEqual(
        moveCardsBody.includes('card.column !== targetCol'),
        true,
        'moveCards must check card.column !== targetCol'
    );

    // 5b. Both handlers reassign currentCards before moving elements, so they MUST hand the
    //     primitive an explicit sourceColumn — otherwise the count decrement and empty-state
    //     restore land on the target column instead of the one the card left.
    assert.strictEqual(
        /entriesToMove\.push\(\{[^}]*sourceColumn:/.test(moveCardsBody),
        true,
        'moveCards must pass an explicit sourceColumn captured before the model reassignment'
    );
    assert.strictEqual(
        /entriesToRevert\.push\(\{[^}]*sourceColumn:/.test(moveFailedBody),
        true,
        'moveCardsFailed must pass an explicit sourceColumn captured before the model reassignment'
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
