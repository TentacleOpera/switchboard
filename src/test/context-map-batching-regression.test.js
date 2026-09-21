'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

/**
 * Extract a `case 'x': { ... }` arm by walking from its opening brace to the
 * matching close at depth zero. Replaces a fixed-character window, which
 * silently expires as the arm grows and turns a documentation edit into a
 * red test. Brace counting is sufficient here: the arm's template literals
 * use balanced `${...}`, and object literals and blocks are balanced by
 * construction — an unbalanced brace inside a string or comment would be the
 * only way to fool it, and the assertion below that the block ends where the
 * next `case` begins catches that.
 */
function extractCaseBlock(src, caseStart) {
    const open = src.indexOf('{', caseStart);
    assert.ok(open !== -1, 'case block: opening brace not found');
    let depth = 1;
    let i = open + 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; }
        i++;
    }
    assert.strictEqual(depth, 0, 'case block: braces never balanced — extraction ran off the end');
    return src.slice(caseStart, i);
}

function run() {
    // Check TaskViewerProvider has batch method and uses correct send pipeline
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');

    assert.ok(
        taskViewerSource.includes('handleAnalystContextMapBatch'),
        'Expected TaskViewerProvider to have handleAnalystContextMapBatch method'
    );

    assert.ok(
        taskViewerSource.includes('_buildBatchAnalystMapPrompt'),
        'Expected TaskViewerProvider to have _buildBatchAnalystMapPrompt helper'
    );

    // Critical: batch handler must use _handleSendAnalystMessage, NOT _sendToTerminal
    const batchMethodStart = taskViewerSource.indexOf('handleAnalystContextMapBatch');
    const batchMethodEnd = taskViewerSource.indexOf('\n    /**', batchMethodStart + 1);
    const batchMethodBlock = batchMethodEnd > batchMethodStart
        ? taskViewerSource.slice(batchMethodStart, batchMethodEnd)
        : taskViewerSource.slice(batchMethodStart, batchMethodStart + 2000);

    assert.ok(
        batchMethodBlock.includes('_handleSendAnalystMessage'),
        'Expected batch handler to send via _handleSendAnalystMessage (not _sendToTerminal)'
    );

    assert.ok(
        !batchMethodBlock.includes('_sendToTerminal'),
        'Batch handler must NOT use non-existent _sendToTerminal method'
    );

    // Verify single-plan fast path
    assert.ok(
        batchMethodBlock.includes('sessionIds.length === 1'),
        'Expected batch handler to have single-plan fast path'
    );

    assert.ok(
        batchMethodBlock.includes('handleAnalystContextMap'),
        'Expected single-plan fast path to delegate to handleAnalystContextMap'
    );

    // Verify content embedding has been removed from prompt builders
    const mapForPlanStart = taskViewerSource.indexOf('_handleAnalystMapForPlan');
    const mapForPlanEnd = taskViewerSource.indexOf('\n    private ', mapForPlanStart + 1);
    const mapForPlanBlock = mapForPlanEnd > mapForPlanStart
        ? taskViewerSource.slice(mapForPlanStart, mapForPlanEnd)
        : taskViewerSource.slice(mapForPlanStart, mapForPlanStart + 2000);

    assert.ok(
        !mapForPlanBlock.includes('**Existing Plan Content:**'),
        'Expected _handleAnalystMapForPlan to no longer embed plan content'
    );

    assert.ok(
        !mapForPlanBlock.includes('planContent'),
        'Expected _handleAnalystMapForPlan to no longer accept planContent parameter'
    );

    const batchPromptStart = taskViewerSource.indexOf('_buildBatchAnalystMapPrompt');
    const batchPromptEnd = taskViewerSource.indexOf('\n    private ', batchPromptStart + 1);
    const batchPromptBlock = batchPromptEnd > batchPromptStart
        ? taskViewerSource.slice(batchPromptStart, batchPromptEnd)
        : taskViewerSource.slice(batchPromptStart, batchPromptStart + 2000);

    assert.ok(
        !batchPromptBlock.includes('**Existing Plan Content:**'),
        'Expected _buildBatchAnalystMapPrompt to no longer embed plan content'
    );

    assert.ok(
        taskViewerSource.includes('@${planFile}'),
        'Expected _buildBatchAnalystMapPrompt to use @ file references'
    );

    // Check KanbanProvider uses batch command instead of loop
    const kanbanProviderPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');

    const codeMapStart = kanbanProviderSource.indexOf("case 'codeMapSelected':");
    assert.ok(codeMapStart >= 0, 'Expected to find codeMapSelected case in KanbanProvider');

    // Brace-matched, NOT a fixed-length slice. A character window is a booby
    // trap: it was 1000 chars, the arm grew past it, and the assertions below
    // went red with no behaviour change at all — which pressures the next
    // person to delete comments to appease the arithmetic. Walking to the
    // matching brace tests the whole arm however long it gets.
    const codeMapBlock = extractCaseBlock(kanbanProviderSource, codeMapStart);

    // The extraction must stop at this arm and not swallow the next one — that
    // is what would let a later arm satisfy these assertions for it.
    const nextCase = kanbanProviderSource.indexOf("\n            case '", codeMapStart + 1);
    assert.ok(
        nextCase === -1 || codeMapStart + codeMapBlock.length <= nextCase + 1,
        'codeMapSelected block extraction overran into the following case arm'
    );

    assert.ok(
        codeMapBlock.includes('analystMapFromKanbanBatch'),
        'Expected codeMapSelected case to use analystMapFromKanbanBatch command'
    );

    assert.ok(
        !codeMapBlock.includes('for (const sessionId of msg.sessionIds)'),
        'Expected codeMapSelected case to not loop through sessionIds individually'
    );

    // Check extension.ts registers the batch command
    const extensionPath = path.join(process.cwd(), 'src', 'extension.ts');
    const extensionSource = fs.readFileSync(extensionPath, 'utf8');

    assert.ok(
        extensionSource.includes('analystMapFromKanbanBatch'),
        'Expected extension.ts to register analystMapFromKanbanBatch command'
    );

    console.log('context map batching regression test passed');
}

try {
    run();
} catch (error) {
    console.error('context map batching regression test failed:', error);
    process.exit(1);
}
