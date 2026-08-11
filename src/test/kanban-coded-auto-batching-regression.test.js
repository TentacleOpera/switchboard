'use strict';

/**
 * CODED_AUTO Batching Regression Test — rewritten for server-side routing.
 *
 * The original test verified the webview's client-side routing logic
 * (dispatchGroups, dropMode, backward/prompt batching). That logic is now
 * deleted — the webview sends `targetColumn: 'CODED_AUTO'` as intent and the
 * server's `_advanceCards` resolves per-card complexity routing, direction
 * classification, and dispatch.
 *
 * This test verifies the new contract:
 *  1. The CODED_AUTO drop block exists and sends 'CODED_AUTO' as intent.
 *  2. The block does NOT contain client-side routing logic (resolveCodedAutoTarget,
 *     dispatchGroups, dropMode, backward/prompt batching).
 *  3. The server's _advanceCards handles complexity routing, direction
 *     classification, and the CLI-triggers gate.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function getCodedAutoDropBlock(source) {
    const startToken = "// Handle drops onto the synthetic CODED_AUTO column";
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

    // 1. The block sends 'CODED_AUTO' as intent.
    assert.ok(
        codedAutoBlock.includes("targetColumn: 'CODED_AUTO'"),
        'Expected CODED_AUTO drop handler to send targetColumn: \'CODED_AUTO\' as intent.'
    );

    // 2. The block does NOT contain client-side routing logic.
    assert.ok(
        !codedAutoBlock.includes('resolveCodedAutoTarget'),
        'CODED_AUTO drop handler must not call resolveCodedAutoTarget — routing is server-side.'
    );
    assert.ok(
        !codedAutoBlock.includes('dispatchGroups'),
        'CODED_AUTO drop handler must not build dispatchGroups — batching is server-side.'
    );
    assert.ok(
        !codedAutoBlock.includes("columnDragDropModes['CODED_AUTO']"),
        'CODED_AUTO drop handler must not read columnDragDropModes — the server handles dispatch mode.'
    );
    assert.ok(
        !codedAutoBlock.includes("type: 'moveCardBackwards'"),
        'CODED_AUTO drop handler must not send moveCardBackwards — direction classification is server-side.'
    );
    assert.ok(
        !codedAutoBlock.includes("type: 'promptOnDrop'"),
        'CODED_AUTO drop handler must not send promptOnDrop — prompt mode is server-side.'
    );

    // 3. The server's _advanceCards handles the routing.
    const providerPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const providerCode = fs.readFileSync(providerPath, 'utf8');
    assert.ok(
        /private\s+async\s+_advanceCards\s*\(/.test(providerCode),
        'Expected _advanceCards method on KanbanProvider.'
    );
    assert.ok(
        providerCode.includes("_partitionByComplexityRoute"),
        'Expected _advanceCards to use _partitionByComplexityRoute for per-card routing.'
    );
    assert.ok(
        providerCode.includes("_isColumnBefore"),
        'Expected _advanceCards to use _isColumnBefore for direction classification.'
    );

    console.log('kanban coded auto batching regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban coded auto batching regression test failed:', error);
    process.exit(1);
}
