'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { deriveKanbanColumn } = require(path.join(process.cwd(), 'src', 'services', 'kanbanColumnDerivation.js'));

function extractBlock(source, startToken, endToken) {
    const start = source.indexOf(startToken);
    const end = source.indexOf(endToken, start + startToken.length);
    assert.ok(start >= 0 && end > start, `Expected to locate block starting with "${startToken}".`);
    return source.slice(start, end);
}

function run() {
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');

    const setColumnBlock = extractBlock(
        taskViewerSource,
        "                case 'setColumn': {",
        "                case 'setComplexity': {"
    );

    assert.ok(
        setColumnBlock.includes('const currentRow = await this._getKanbanPlanRecordForSession(workspaceRoot, sessionId);') &&
        setColumnBlock.includes('const currentColumn = this._getEffectiveKanbanColumnForSession(sheet, customAgents, currentRow);') &&
        setColumnBlock.includes('const workflowName = this._workflowForManualColumnChange(currentColumn, column, customAgents);') &&
        setColumnBlock.includes('await this._applyManualKanbanColumnChange(') &&
        setColumnBlock.includes("'User manually changed plan column from ticket view'"),
        'Expected ticket-view setColumn updates to persist through the manual-move workflow path instead of transient DB-only writes.'
    );
    assert.ok(
        !setColumnBlock.includes('await db.updateColumn(sessionId, column);'),
        'Expected ticket-view setColumn updates to avoid DB-only writes that can snap back after refresh.'
    );

    const manualMoveHelperBlock = extractBlock(
        taskViewerSource,
        '    private _workflowForManualColumnChange(',
        '    private _plannerWorkflowNameForInstruction('
    );
    assert.ok(
        manualMoveHelperBlock.includes("return 'reset-to-' + normalizedTarget.toLowerCase().replace(/\\s+/g, '-');") &&
        manualMoveHelperBlock.includes('return this._workflowForForwardMove(normalizedTarget);'),
        'Expected manual ticket-view column changes to reuse reset/move workflow semantics.'
    );

    const sharedApplyHelperBlock = extractBlock(
        taskViewerSource,
        '    private async _applyManualKanbanColumnChange(',
        '    private _plannerWorkflowNameForInstruction('
    );
    assert.ok(
        sharedApplyHelperBlock.includes('await this._updateSessionRunSheet(sessionId, workflowName, outcome, true, resolvedWorkspaceRoot);') &&
        sharedApplyHelperBlock.includes('await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, normalizedTargetColumn);'),
        'Expected manual column changes to persist both runsheet history and Kanban DB state.'
    );

    const forwardMoveMethod = extractBlock(
        taskViewerSource,
        '    public async handleKanbanForwardMove(',
        '    /**'
    );
    assert.ok(
        forwardMoveMethod.includes('await this._applyManualKanbanColumnChange(') &&
        forwardMoveMethod.includes("'User manually moved plan forwards'"),
        'Expected forward move controls to keep using the shared manual move persistence helper.'
    );

    const backwardMoveMethod = extractBlock(
        taskViewerSource,
        '    public async handleKanbanBackwardMove(',
        '    private _workflowForForwardMove('
    );
    assert.ok(
        backwardMoveMethod.includes('await this._applyManualKanbanColumnChange(') &&
        backwardMoveMethod.includes("'User manually moved plan backwards'"),
        'Expected backward move controls to keep using the shared manual move persistence helper.'
    );

    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'reset-to-plan-reviewed' }], []),
        'PLAN REVIEWED',
        'Expected reset-to-plan-reviewed to survive refresh derivation for ticket-view backward column edits.'
    );
    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'move-to-coder-coded' }], []),
        'CODER CODED',
        'Expected move-to-coder-coded to survive refresh derivation for ticket-view forward column edits.'
    );

    console.log('review column persistence regression test passed');
}

try {
    run();
} catch (error) {
    console.error('review column persistence regression test failed:', error);
    process.exit(1);
}
