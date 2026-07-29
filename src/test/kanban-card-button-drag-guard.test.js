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

    // Assertion 8: In KanbanProvider.ts, copyPlanLinkResult postMessage occurs after moveCards / no nextCol returns in promptSelected
    const promptSelectedIdx = kanbanProvider.indexOf("case 'promptSelected':");
    assert.strictEqual(promptSelectedIdx !== -1, true, "case 'promptSelected': must exist");
    const promptSelectedBody = kanbanProvider.slice(promptSelectedIdx, promptSelectedIdx + 4500);
    assert.match(
        promptSelectedBody,
        /this\.postMessage\(\{\s*type:\s*'moveCards'[\s\S]*?\}\);[\s\S]*?this\.postMessage\(\{\s*type:\s*'copyPlanLinkResult'/,
        'copyPlanLinkResult postMessage must follow moveCards postMessage'
    );

    console.log('testKanbanCardButtonDragGuard passed all assertions successfully.');
}

module.exports = { testKanbanCardButtonDragGuard };

if (require.main === module) {
    testKanbanCardButtonDragGuard();
}
