'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
const providerSource = fs.readFileSync(providerPath, 'utf8');
const { deriveKanbanColumn } = require(path.join(process.cwd(), 'src', 'services', 'kanbanColumnDerivationImpl.js'));

function run() {
    const start = providerSource.indexOf("case 'setColumn': {");
    const end = providerSource.indexOf("case 'setComplexity': {", start);

    assert.ok(start >= 0 && end > start, 'Expected to locate the setColumn branch in updateReviewTicket().');

    const setColumnBranch = providerSource.slice(start, end);

    assert.ok(
        setColumnBranch.includes('const columns = buildKanbanColumns(customAgents).map(entry => entry.id);'),
        'Expected ticket-view column updates to validate against the live Kanban column list.'
    );
    assert.ok(
        setColumnBranch.includes('const currentRow = await this._getKanbanPlanRecordForSession(workspaceRoot, sessionId);') &&
        setColumnBranch.includes('const currentColumn = this._getEffectiveKanbanColumnForSession(sheet, customAgents, currentRow);'),
        'Expected ticket-view column updates to compare against the current ticket column before moving.'
    );
    assert.ok(
        setColumnBranch.includes('const workflowName = this._workflowForManualColumnChange(currentColumn, column, customAgents);') &&
        setColumnBranch.includes('await this._applyManualKanbanColumnChange('),
        'Expected ticket-view column updates to reuse the shared manual Kanban change persistence path.'
    );
    assert.ok(
        !setColumnBranch.includes('await db.updateColumn(sessionId, column);'),
        'Expected ticket-view column updates not to bypass runsheet persistence with a direct DB-only write.'
    );

    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'reset-to-created' }], []),
        'CREATED',
        'reset-to-created should survive refresh by deriving back to CREATED'
    );
    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'move-to-plan-reviewed' }], []),
        'PLAN REVIEWED',
        'move-to-plan-reviewed should survive refresh by deriving to PLAN REVIEWED'
    );
    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'move-to-lead-coded' }], []),
        'LEAD CODED',
        'move-to-lead-coded should survive refresh by deriving to LEAD CODED'
    );
    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'reset-to-coder-coded' }], []),
        'CODER CODED',
        'reset-to-coder-coded should survive refresh by deriving back to CODER CODED'
    );
    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'move-to-acceptance-tested' }], []),
        'ACCEPTANCE TESTED',
        'move-to-acceptance-tested should survive refresh by deriving to ACCEPTANCE TESTED'
    );

    console.log('review ticket column persistence regression test passed');
}

try {
    run();
} catch (error) {
    console.error('review ticket column persistence regression test failed:', error);
    process.exit(1);
}
