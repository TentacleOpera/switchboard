const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Unit test for kanban card button drag guard
function testKanbanCardButtonDragGuard() {
    const kanbanHtmlPath = path.join(__dirname, '../webview/kanban.html');
    const kanbanHtml = fs.readFileSync(kanbanHtmlPath, 'utf8');

    const kanbanProviderPath = path.join(__dirname, '../services/KanbanProvider.ts');
    const kanbanProvider = fs.readFileSync(kanbanProviderPath, 'utf8');

    // Assertion 1: Capture-phase pointerdown listener sets draggable = false on closest .kanban-card, rearms on pointerup, pointercancel, dragend
    assert.match(
        kanbanHtml,
        /document\.addEventListener\('pointerdown',\s*\(e\)\s*=>\s*\{[\s\S]*?card\.draggable\s*=\s*false;[\s\S]*?pointerup[\s\S]*?pointercancel[\s\S]*?dragend[\s\S]*?\},?\s*true\);/,
        'Expected capture-phase pointerdown listener disarming card drag and rearming on release'
    );

    // Assertion 2: handleDragStart has a guard for buttonPressCardEl returning early before draggedSessionId assignment
    const handleDragStartIdx = kanbanHtml.indexOf('function handleDragStart(e)');
    assert.strictEqual(handleDragStartIdx !== -1, true, 'handleDragStart function must exist');
    const dragStartBody = kanbanHtml.slice(handleDragStartIdx, handleDragStartIdx + 300);
    assert.match(
        dragStartBody,
        /if\s*\(\s*buttonPressCardEl\s*\)\s*\{\s*e\.preventDefault\(\);\s*return;\s*\}/,
        'handleDragStart must check buttonPressCardEl and preventDefault'
    );

    // Assertion 3: Negative assertion — handleDragStart does NOT contain e.target.closest('button')
    assert.strictEqual(
        dragStartBody.includes("e.target.closest('button')"),
        false,
        "handleDragStart must NOT rely on e.target.closest('button') which targets the card"
    );

    // Assertion 4: Negative assertion — createCardHtml's buttons do NOT carry draggable="false"
    assert.strictEqual(
        kanbanHtml.includes('draggable="false"'),
        false,
        'createCardHtml buttons should not carry inert draggable="false" attributes'
    );

    // Assertion 5: Stage 2 pointer capture on pointerdown, runCopyPrompt exists, no click listener bound to .card-btn.copy
    assert.match(kanbanHtml, /function runCopyPrompt\(btn\)/, 'runCopyPrompt function should exist');
    assert.match(kanbanHtml, /btn\.setPointerCapture\(e\.pointerId\)/, 'setPointerCapture on pointerdown should exist');
    assert.strictEqual(
        /document\.querySelectorAll\('\.card-btn\.copy'\)\.forEach\(btn\s*=>\s*\{\s*btn\.addEventListener\('click'/.test(kanbanHtml),
        false,
        'card-btn.copy should NOT have a click listener bound directly (uses pointerdown stream)'
    );

    // Assertion 6: .card-btn min-height: 22px and .card-btn.icon-btn height: 22px
    assert.match(kanbanHtml, /\.card-btn\s*\{[\s\S]*?min-height:\s*22px;/);
    assert.match(kanbanHtml, /\.card-btn\.icon-btn\s*\{[\s\S]*?height:\s*22px;/);

    // Assertion 7: .card-btn.copy.copied does NOT have pointer-events: none
    const copiedRuleMatch = kanbanHtml.match(/\.card-btn\.copy\.copied\s*\{([^}]+)\}/);
    assert.strictEqual(copiedRuleMatch !== null, true, '.card-btn.copy.copied rule must exist');
    assert.strictEqual(
        copiedRuleMatch[1].includes('pointer-events: none'),
        false,
        '.card-btn.copy.copied must not disable pointer events'
    );

    // Assertion 7b: copyPlanLinkResult handler does NOT set btn.disabled = true
    // The disabled attribute blocks pointerdown, which is the Stage 2 activation path.
    const copyResultIdx = kanbanHtml.indexOf("case 'copyPlanLinkResult':");
    assert.strictEqual(copyResultIdx !== -1, true, "case 'copyPlanLinkResult': must exist");
    const copyResultEnd = kanbanHtml.indexOf('break;', copyResultIdx);
    const copyResultBody = kanbanHtml.slice(copyResultIdx, copyResultEnd);
    assert.strictEqual(
        copyResultBody.includes('btn.disabled = true'),
        false,
        'copyPlanLinkResult handler must NOT set btn.disabled (blocks pointerdown activation)'
    );
    assert.strictEqual(
        copyResultBody.includes('btn.disabled = false'),
        false,
        'copyPlanLinkResult handler must NOT toggle btn.disabled at all'
    );

    // Assertion 8: In KanbanProvider.ts, copyPlanLinkResult postMessage occurs after moveCards
    // on branches that DO have moveCards. The no-next-column branch correctly sends
    // copyPlanLinkResult without moveCards (no card movement), so we test the
    // custom-dispatch and plain-advance branches specifically.
    const promptSelectedIdx = kanbanProvider.indexOf("case 'promptSelected':");
    assert.strictEqual(promptSelectedIdx !== -1, true, "case 'promptSelected': must exist");
    // Use a generous window to cover all branches including PLAN REVIEWED complexity routing
    const promptSelectedBody = kanbanProvider.slice(promptSelectedIdx, promptSelectedIdx + 8000);

    // Custom-dispatch branch: moveCards then copyPlanLinkResult
    assert.match(
        promptSelectedBody,
        /this\.postMessage\(\{\s*type:\s*'moveCards',\s*sessionIds:\s*allMovedIds,\s*targetColumn:\s*nextCol\s*\}\);[\s\S]*?this\.postMessage\(\{\s*type:\s*'copyPlanLinkResult'/,
        'Custom-dispatch branch: copyPlanLinkResult must follow moveCards'
    );

    // Plain-advance branch: also has moveCards then copyPlanLinkResult.
    // Verify by checking that the LAST moveCards in the handler is followed by copyPlanLinkResult.
    const lastMoveCards = promptSelectedBody.lastIndexOf("type: 'moveCards'");
    const lastCopyResult = promptSelectedBody.lastIndexOf("type: 'copyPlanLinkResult'");
    assert.ok(lastMoveCards > 0, 'Plain-advance branch must have a moveCards postMessage');
    assert.ok(lastCopyResult > lastMoveCards,
        'Plain-advance branch: copyPlanLinkResult must appear after the last moveCards');

    console.log('testKanbanCardButtonDragGuard passed all assertions successfully.');
}

module.exports = { testKanbanCardButtonDragGuard };

if (require.main === module) {
    testKanbanCardButtonDragGuard();
}
