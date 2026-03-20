'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const kanbanProviderPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const reviewHtmlPath = path.join(process.cwd(), 'src', 'webview', 'review.html');

    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
    const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
    const reviewHtmlSource = fs.readFileSync(reviewHtmlPath, 'utf8');

    const start = taskViewerSource.indexOf('public async sendReviewTicketToNextAgent(sessionId: string)');
    const end = taskViewerSource.indexOf('public async handleKanbanReviewPlan(sessionId: string, workspaceRoot?: string)');

    assert.ok(start >= 0 && end > start, 'Expected to locate sendReviewTicketToNextAgent() in TaskViewerProvider.');

    const sendReviewMethod = taskViewerSource.slice(start, end);

    assert.ok(
        reviewHtmlSource.includes("vscode.postMessage({ type: 'sendToAgent', sessionId: state.sessionId });"),
        'Expected the ticket view Send to Agent button to post the dedicated sendToAgent action.'
    );
    assert.ok(
        sendReviewMethod.includes('const targetColumn = await this._getNextKanbanColumnForSession(currentColumn, sessionId, workspaceRoot, customAgents);'),
        'Expected ticket-view send to keep existing next-column resolution.'
    );
    assert.ok(
        sendReviewMethod.includes("const instruction = role === 'planner' ? 'improve-plan' : undefined;") &&
        sendReviewMethod.includes('const dispatched = await this.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot);'),
        'Expected ticket-view send to continue using the normal dispatch path and planner instruction mapping.'
    );
    assert.ok(
        sendReviewMethod.includes('await this.handleKanbanForwardMove([sessionId], targetColumn, workspaceRoot);') &&
        sendReviewMethod.includes('return { ok: true, message: `Moved to ${targetColumn}.` };'),
        'Expected ticket-view send to preserve the no-role fallback move behavior.'
    );
    assert.ok(
        !sendReviewMethod.includes('cliTriggersEnabled') &&
        !sendReviewMethod.includes('CLI triggers are off'),
        'Expected ticket-view send to ignore the Kanban CLI trigger toggle.'
    );
    assert.ok(
        kanbanProviderSource.includes("case 'triggerAction': {") &&
        kanbanProviderSource.includes("case 'triggerBatchAction': {") &&
        kanbanProviderSource.includes('if (!this._cliTriggersEnabled) {'),
        'Expected Kanban CLI trigger gating to remain scoped to Kanban trigger handlers.'
    );

    console.log('review send-agent trigger regression test passed');
}

try {
    run();
} catch (error) {
    console.error('review send-agent trigger regression test failed:', error);
    process.exit(1);
}
