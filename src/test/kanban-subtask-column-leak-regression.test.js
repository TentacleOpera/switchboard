'use strict';

// Regression: epic subtasks must NOT leak into column-batch operations.
//
// An epic's subtasks each carry their own `kanban_column`, independent of the
// epic's column. The board (kanban.html) rolls subtasks up under their epic and
// does NOT render them as loose column cards (`displayCards.filter(card => !card.epicId)`).
// Column-batch handlers in KanbanProvider (Advance All / moveAll, promptAll,
// completeAll, batch planner/coder prompts, and the per-role prompt previews)
// therefore MUST exclude subtask cards too — otherwise a subtask whose column
// happens to match (e.g. CREATED) gets swept into the operation even though its
// epic sits in a different column (e.g. BACKLOG). That divergence caused
// "Advance All" on CREATED to dispatch a BACKLOG epic's subtasks instead of the
// loose plans the user could actually see.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function getCaseBlock(source, caseName) {
    const startToken = `case '${caseName}': {`;
    const start = source.indexOf(startToken);
    assert.ok(start >= 0, `could not find ${caseName} handler`);
    const nextCase = source.indexOf("\n            case '", start + startToken.length);
    return source.slice(start, nextCase >= 0 ? nextCase : source.length);
}

function run() {
    const sourcePath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');

    // 1. The shared helper exists and applies the subtask exclusion that mirrors
    //    the webview's display contract.
    const helperMatch = source.match(/private _visibleColumnCards\([^)]*\)\s*:\s*KanbanCard\[\]\s*\{[\s\S]*?\n {4}\}/);
    assert.ok(helperMatch, '_visibleColumnCards helper must exist');
    assert.ok(
        /card\.column === column && !card\.epicId/.test(helperMatch[0]),
        '_visibleColumnCards must exclude subtask cards via !card.epicId'
    );

    // 2. Every column-batch handler must source its cards through the helper, not
    //    a raw column filter that would re-admit subtasks.
    const columnBatchCases = ['moveAll', 'promptAll', 'completeAll'];
    for (const caseName of columnBatchCases) {
        const block = getCaseBlock(source, caseName);
        assert.ok(
            block.includes('_visibleColumnCards('),
            `${caseName} must select source cards via _visibleColumnCards (subtask-safe)`
        );
        assert.ok(
            !/_lastCards\.filter\(card => card\.workspaceRoot === workspaceRoot && card\.column ===/.test(block),
            `${caseName} must NOT use a raw column filter (would re-admit epic subtasks)`
        );
    }

    // 3. The batch planner / coder prompt handlers also route through the helper.
    assert.ok(
        source.includes("_visibleColumnCards(workspaceRoot, 'CREATED')"),
        'batch planner prompt (CREATED) must use _visibleColumnCards'
    );
    assert.ok(
        source.includes("_visibleColumnCards(workspaceRoot, 'PLAN REVIEWED').filter(card => this._isLowComplexity(card))"),
        'batch low-complexity coder/Jules prompt (PLAN REVIEWED) must use _visibleColumnCards'
    );

    // 4. The per-role prompt-preview filters skip subtasks so previews match dispatch.
    const previewGuards = source.match(/if \(c\.epicId\) return false;/g) || [];
    assert.ok(
        previewGuards.length >= 2,
        'both per-role prompt-preview filters must skip subtask cards (if (c.epicId) return false;)'
    );

    // 5. Reroute sendToBacklog and sendToNew to moveCardToColumn for cascading subtasks
    const backlogBlock = getCaseBlock(source, 'sendToBacklog');
    assert.ok(backlogBlock.includes('moveCardToColumn('), 'sendToBacklog must call moveCardToColumn');
    assert.ok(!backlogBlock.includes('db.updateColumn(resolvedSessionId'), 'sendToBacklog must NOT call db.updateColumn directly');

    const newBlock = getCaseBlock(source, 'sendToNew');
    assert.ok(newBlock.includes('moveCardToColumn('), 'sendToNew must call moveCardToColumn');
    assert.ok(!newBlock.includes('db.updateColumn(resolvedSessionId'), 'sendToNew must NOT call db.updateColumn directly');

    // 6. completeAll must cascade column updates for epic cards so subtasks follow
    //    to COMPLETED (same rigid-unit model — an epic's subtasks share its column).
    const completeBlock = getCaseBlock(source, 'completeAll');
    assert.ok(
        completeBlock.includes('updateColumnWithEpicCascade('),
        'completeAll must cascade epic column updates via updateColumnWithEpicCascade'
    );
    assert.ok(
        completeBlock.includes('card.isEpic'),
        'completeAll must branch on card.isEpic to detect epic cards'
    );

    console.log('kanban subtask column-leak regression test passed');
}

run();
