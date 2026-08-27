'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { deriveKanbanColumn } = require(path.join(process.cwd(), 'src', 'services', 'kanbanColumnDerivationImpl.js'));

function extractBlock(source, startToken, endToken) {
    const start = source.indexOf(startToken);
    const end = source.indexOf(endToken, start + startToken.length);
    assert.ok(start >= 0 && end > start, `Expected to locate block starting with "${startToken}".`);
    return source.slice(start, end);
}

function run() {
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');

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
        '    public async recordRunSheetForColumnMove('
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

    assert.ok(
        !/\bderiveKanbanColumn\s*\(/.test(taskViewerSource),
        'Expected TaskViewerProvider to determine a column from plans.kanban_column only — the event log must never override the DB column.'
    );

    const kanbanProviderSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'),
        'utf8'
    );
    const eligibleBlock = extractBlock(
        kanbanProviderSource,
        '    private async _getEligibleSessionIds(',
        '    private async _advanceSessionsInColumn('
    );
    assert.ok(
        !/\bderiveKanbanColumn\s*\(/.test(eligibleBlock) && eligibleBlock.includes('await db.getPlanBySessionId(sessionId)'),
        'Expected _getEligibleSessionIds to read the current column from the DB, not derive it from the event log.'
    );
    const advanceBlock = extractBlock(
        kanbanProviderSource,
        '    private async _advanceSessionsInColumn(',
        '\n    /**'
    );
    assert.ok(
        advanceBlock.includes('await db.getPlanBySessionId(sessionId)'),
        'Expected _advanceSessionsInColumn to read the current column from the DB, not derive it from the event log.'
    );
    assert.ok(
        advanceBlock.includes('deriveKanbanColumn([{ workflow: workflowName }], customAgents)') &&
        !/deriveKanbanColumn\(updatedEvents/.test(advanceBlock),
        'Expected the advance target to be derived from the freshly-pushed workflow alone — scanning the whole event log lets stale events move a card backwards.'
    );

    console.log('review column persistence regression test passed');
}

try {
    run();
} catch (error) {
    console.error('review column persistence regression test failed:', error);
    process.exit(1);
}
