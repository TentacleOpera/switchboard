'use strict';

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

async function run() {
    const sourcePath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const source = await fs.promises.readFile(sourcePath, 'utf8');

    const plannerBlock = getCaseBlock(source, 'batchPlannerPrompt');
    assert.ok(plannerBlock.includes('_advanceSessionsInColumn'), 'batchPlannerPrompt should advance CREATED cards after copying the planner prompt');

    const coderBlock = getCaseBlock(source, 'batchLowComplexity');
    assert.ok(coderBlock.includes('_advanceSessionsInColumn'), 'batchLowComplexity should advance PLAN REVIEWED cards after copying the coder prompt');

    console.log('kanban batch prompt regression test passed');
}

run().catch((error) => {
    console.error('kanban batch prompt regression test failed:', error);
    process.exit(1);
});
