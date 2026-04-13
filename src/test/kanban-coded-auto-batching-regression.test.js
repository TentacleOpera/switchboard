'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function getCodedAutoDropBlock(source) {
    const startToken = "// Handle drops onto the synthetic CODED_AUTO column — route each card to its real column";
    const endToken = "\n            const forwardIds = [];";
    const start = source.indexOf(startToken);
    const end = source.indexOf(endToken, start);

    assert.ok(start >= 0, 'Expected CODED_AUTO drop handler comment in kanban.html.');
    assert.ok(end > start, 'Expected to locate the end of the CODED_AUTO drop handler block.');

    return source.slice(start, end);
}

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const source = fs.readFileSync(kanbanHtmlPath, 'utf8');
    const codedAutoBlock = getCodedAutoDropBlock(source);

    assert.ok(
        codedAutoBlock.includes('const dispatchGroups = new Map();'),
        'Expected CODED_AUTO drop handler to group dispatches before posting messages.'
    );
    assert.ok(
        codedAutoBlock.includes("type: 'triggerBatchAction'"),
        'Expected CODED_AUTO drop handler to use triggerBatchAction for multi-card CLI drops.'
    );
    assert.ok(
        codedAutoBlock.includes("type: 'moveCardBackwards'") &&
        codedAutoBlock.includes('sessionIds: groupedIds'),
        'Expected CODED_AUTO drop handler to batch backward moves with grouped sessionIds.'
    );
    assert.ok(
        codedAutoBlock.includes("type: 'promptOnDrop'") &&
        codedAutoBlock.includes('sourceColumn: group.sourceColumn'),
        'Expected CODED_AUTO drop handler to preserve sourceColumn when batching prompt-mode drops.'
    );
    assert.ok(
        /const groupKey = dispatchType === 'prompt'[\s\S]*sourceColumnForPrompt/s.test(codedAutoBlock),
        'Expected prompt-mode grouping to split batches by source column when necessary.'
    );
    assert.ok(
        !/postKanbanMessage\(\{\s*type:\s*'triggerAction',\s*sessionId:\s*id,/s.test(codedAutoBlock),
        'Expected CODED_AUTO drop handler to stop dispatching one triggerAction per card inside the routing loop.'
    );
    assert.ok(
        !/postKanbanMessage\(\{\s*type:\s*'moveCardBackwards',\s*sessionIds:\s*\[id\]/s.test(codedAutoBlock),
        'Expected CODED_AUTO drop handler to stop dispatching one backward payload per card.'
    );

    console.log('kanban coded auto batching regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban coded auto batching regression test failed:', error);
    process.exit(1);
}
