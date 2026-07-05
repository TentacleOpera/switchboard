'use strict';

// Regression: feature subtasks must NOT leak into column-batch operations.
//
// An feature's subtasks each carry their own `kanban_column`, independent of the
// feature's column. The board (kanban.html) rolls subtasks up under their feature and
// does NOT render them as loose column cards (`displayCards.filter(card => !card.featureId)`).
// Column-batch handlers in KanbanProvider (Advance All / moveAll, promptAll,
// completeAll, batch planner/coder prompts, and the per-role prompt previews)
// therefore MUST exclude subtask cards too — otherwise a subtask whose column
// happens to match (e.g. CREATED) gets swept into the operation even though its
// feature sits in a different column (e.g. BACKLOG). That divergence caused
// "Advance All" on CREATED to dispatch a BACKLOG feature's subtasks instead of the
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
        /card\.column === column && !card\.featureId/.test(helperMatch[0]),
        '_visibleColumnCards must exclude subtask cards via !card.featureId'
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
            `${caseName} must NOT use a raw column filter (would re-admit feature subtasks)`
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
    const previewGuards = source.match(/if \(c\.featureId\) return false;/g) || [];
    assert.ok(
        previewGuards.length >= 2,
        'both per-role prompt-preview filters must skip subtask cards (if (c.featureId) return false;)'
    );

    // 5. Reroute sendToBacklog and sendToNew to moveCardToColumn for cascading subtasks
    const backlogBlock = getCaseBlock(source, 'sendToBacklog');
    assert.ok(backlogBlock.includes('moveCardToColumn('), 'sendToBacklog must call moveCardToColumn');
    assert.ok(!backlogBlock.includes('db.updateColumn(resolvedSessionId'), 'sendToBacklog must NOT call db.updateColumn directly');

    const newBlock = getCaseBlock(source, 'sendToNew');
    assert.ok(newBlock.includes('moveCardToColumn('), 'sendToNew must call moveCardToColumn');
    assert.ok(!newBlock.includes('db.updateColumn(resolvedSessionId'), 'sendToNew must NOT call db.updateColumn directly');

    // 6. completeAll must cascade column updates for feature cards so subtasks follow
    //    to COMPLETED (same rigid-unit model — an feature's subtasks share its column).
    const completeBlock = getCaseBlock(source, 'completeAll');
    assert.ok(
        completeBlock.includes('cascadeFeatureByPlanId('),
        'completeAll must cascade feature column updates via cascadeFeatureByPlanId'
    );
    assert.ok(
        completeBlock.includes('card.isFeature'),
        'completeAll must branch on card.isFeature to detect feature cards'
    );

    // 7. Frontend collector: getAllInColumn must exclude subtask cards (!c.featureId)
    //    on BOTH return paths, mirroring the backend _visibleColumnCards contract.
    //    The backend was fixed in commit 3fff80a but the frontend collector was
    //    never touched — this test prevents that exact regression.
    const htmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const collectorMatch = html.match(/function getAllInColumn\(col\)\s*\{[\s\S]*?\n\s{8}\}/);
    assert.ok(collectorMatch, 'getAllInColumn function must exist in kanban.html');

    // Both the CODED_AUTO branch and the default branch must exclude subtasks.
    const collectorBody = collectorMatch[0];
    const codedAutoFilter = collectorBody.match(/CODED_IDS\.includes\(c\.column\)([^)]*)\)/);
    assert.ok(
        codedAutoFilter && /!c\.featureId/.test(codedAutoFilter[0]),
        'getAllInColumn CODED_AUTO branch must exclude subtask cards via !c.featureId'
    );
    const defaultFilter = collectorBody.match(/c\.column === col([^)]*)\)/);
    assert.ok(
        defaultFilter && /!c\.featureId/.test(defaultFilter[0]),
        'getAllInColumn default branch must exclude subtask cards via !c.featureId'
    );

    // 8. groupAllIntoFeature must resolve the effective column in backlog view.
    //    In backlog view, the CREATED column slot displays BACKLOG cards (remapped
    //    via _effectiveColumn at render time). The handler must call getAllInColumn
    //    with 'BACKLOG' when showingBacklog && column === 'CREATED', not the raw
    //    'CREATED' column — otherwise it groups hidden real-CREATED cards instead
    //    of the visible BACKLOG cards.
    const groupBlock = html.match(/case 'groupAllIntoFeature':\s*\{[\s\S]*?break;/);
    assert.ok(groupBlock, 'groupAllIntoFeature handler must exist in kanban.html');
    assert.ok(
        /showingBacklog[\s\S]*'CREATED'[\s\S]*'BACKLOG'/.test(groupBlock[0]),
        'groupAllIntoFeature must resolve effective column (BACKLOG) when showingBacklog && column === CREATED'
    );
    assert.ok(
        /getAllInColumn\(effectiveCol\)/.test(groupBlock[0]),
        'groupAllIntoFeature must call getAllInColumn with the resolved effective column, not the raw column'
    );

    // 9. In backlog view, the four pipeline buttons (moveSelected, moveAll,
    //    promptSelected, promptAll) must be suppressed on the CREATED column —
    //    backlog is a holding pen, not a pipeline stage. Only the feature-group
    //    button should remain. The gate is `(isCreated && showingBacklog)`.
    assert.ok(
        /pipelineButtons = \(isCreated && showingBacklog\) \? '' :/.test(html),
        'pipeline buttons must be suppressed (empty string) when isCreated && showingBacklog'
    );

    console.log('kanban subtask column-leak regression test passed');
}

run();
