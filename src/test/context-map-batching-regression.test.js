'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

    // Extract a larger context window (1000 chars) to include the full case block
    const codeMapBlock = kanbanProviderSource.slice(codeMapStart, codeMapStart + 1000);

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
